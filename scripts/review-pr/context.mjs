#!/usr/bin/env node
// context.mjs — review-pr 的一次性「采集 + 客观判定」核心(只读,在当前分支跑即可)
//
// 把 skill 步骤 1.1 / 1.2 / 1.3 / 1.5 / 1.6.5 里所有「确定性」的活一次性做完,输出
// 一份结构化 JSON 给 LLM:PR 元数据、文件 / diffstat、格式硬判定、讨论历史、前置门判定。
// LLM 拿到后只需做「语义判断 + 决策」:
//   - 格式:formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)。
//   - 前置门:gate.gatePass=false → 1.7 必须卡 gate;gate.softFlags 里的 bot 评论 /
//     疑似打回由 LLM 读内容定性。
//
// 本脚本不发评论、不改本地、不起审查。退出码恒 0(除脚本自身出错=1);
// 判定结论全在 JSON 字段里(formatPass / gate.gatePass),不靠退出码分流。
//
// --scan 精简模式(auto 批处理阶段 1 专用):判定全量照算,但输出**不含** body 全文、
// 评论 / review thread / 提交时间线全文——只留分类决策与汇总所需的最小字段 + filePaths
// (供文件重叠守卫比对)。动机:批处理要对几十个候选各跑一次本脚本,全量 JSON(含全文
// 历史)会把主 agent 的 session 上下文撑爆并造成跨 PR 串扰;全文只应进对应 PR 的审查
// 子 agent 隔离上下文(子 agent 在自己 worktree 里跑不带 --scan 的全量模式自取)。
//
// --scan-all 批量模式(auto 批处理阶段 1 专用):不传 PR 号,脚本自己拉全部 open 非 draft
// 候选,内部并行(4 并发)spawn 自身的单 PR `--scan` 模式,聚合输出 results 数组——把主
// agent「N 个候选 = N 次工具调用」压成 1 次;核心判定逻辑与单 PR 模式**同一份代码**
// (就是 spawn 自己),不存在两套判定漂移。单个候选失败不炸整批(该条 ok:false)。
// 扫描完成后顺手落盘空转指纹(.last-scan.json,供 scheduler pre-check.mjs 比对,见 lib.mjs)。
//
// 跑:node scripts/review-pr/context.mjs <PR> [--scan]
//     node scripts/review-pr/context.mjs --scan-all

import { parseRepo, parsePR, gh, ghJson, ghGraphql, classifyHeadChecks, probeBranchProtection, loadOrgRosters, parseRosterLine, print, fail, fetchOpenPrSnapshot, computePrSetFingerprint, SCAN_STATE_FILE, spawnScriptJson, mapPool, PRODUCT_GATE_MARKER_PREFIX, parseLastHoldMarker } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── PR 提交规范的格式判定数据:单一真相源在 agent-use/docs/pr-rules.json ──
// featureSections / bugfixSections 需与 .github/PULL_REQUEST_TEMPLATE.md 的必填段落
// 一致(本仓模板统一三节制,feature/bugfix 共用;sync 脚本双向校验,改一边忘改另一边会报错);
// titleTypes 无模板锚点,单一真相源就是那个 json 自己;
// lightTypes / redlinePaths / serverPaths 也只在那个 json(供本脚本判定,PR 模板无对应)。
const prRules = JSON.parse(
  readFileSync(new URL('../../agent-use/docs/pr-rules.json', import.meta.url), 'utf8'),
);
const TITLE_TYPE_RE = new RegExp(`^(${prRules.titleTypes.join('|')})(\\([^)]+\\))?!?: .+`);
const LIGHT_TYPES = prRules.lightTypes; // 轻档:不强制段落
const FEATURE_SECTIONS = prRules.featureSections;
const BUGFIX_SECTIONS = prRules.bugfixSections;
const REDLINE_PATH_RE = new RegExp(prRules.redlinePaths.join('|'));
// CI 配置敏感路径:PR 改了它们 → approve fork workflow 会执行被改过的 CI(详见 approve-workflows.mjs 安全门)
const CI_SENSITIVE_RE = prRules.ciSensitivePaths?.length ? new RegExp(prRules.ciSensitivePaths.join('|')) : null;
// 产品/UI 变更门:白名单(GitHub login,大小写不敏感)+ UI 面路径前缀(详见 SKILL「产品 / UI 变更门」)
const PRODUCT_WHITELIST = (prRules.productWhitelist ?? []).map((s) => s.toLowerCase());
const UI_PATH_PREFIXES = prRules.uiPaths ?? [];
// 技术架构变更门:与产品门同机制的技术侧平行门(详见 SKILL「技术架构变更门」)。
// 触发器三选一命中即进语义定性:核心路径改动量 / refactor 大 diff / 任意类型超大 diff。
const ARCH_RULES = prRules.archGate ?? {};
const ARCH_WHITELIST = (ARCH_RULES.whitelist ?? []).map((s) => s.toLowerCase());
const ARCH_CORE_PATHS = ARCH_RULES.corePaths ?? [];
const ARCH_CORE_DIFF_LINES = Number(ARCH_RULES.coreDiffLines) || 150;
const ARCH_REFACTOR_DIFF_LINES = Number(ARCH_RULES.refactorDiffLines) || 400;
const ARCH_ANY_DIFF_LINES = Number(ARCH_RULES.anyTypeDiffLines) || 800;
// 自动跟进修复名单:这些作者的 PR 卡在作者侧问题时不打回 / 不催办,由 skill 开跟进会话自己修
// (owner 本人的 PR 对自动化账号是 own-pr,GitHub 禁止对自己的 PR 提 REQUEST_CHANGES / APPROVE,
// 打回路径本来就走不通),详见 SKILL「自动跟进修复(fix-handoff)」。
const SELF_FIX_AUTHORS = (prRules.selfFixAuthors ?? []).map((s) => s.toLowerCase());
// Slack 同步 bot(信任锚):只有这些账号发的讨论 issue 评论才允许按正文「发送者:」归属真实发言人,
// 防止普通用户伪造「发送者:<白名单成员>」冒充放行。比对时去掉 GitHub App 的 [bot] 后缀。
const SLACK_SYNC_BOTS = (prRules.slackSyncBots ?? []).map((s) => s.toLowerCase());
const normalizeBotLogin = (login) => (login ?? '').toLowerCase().replace(/\[bot\]$/, '');
// Slack 显示名 → GitHub login 别名(大小写不敏感):兜「Slack 名与名录中文名对不上」的情况(Dash=dashhuang)
const SLACK_SENDER_ALIASES = Object.fromEntries(
  Object.entries(prRules.slackSenderAliases ?? {}).map(([k, v]) => [k.toLowerCase(), (v ?? '').toLowerCase()]),
);

// ── 以下是 review-pr skill 自身的执行细则(非 agent 约束文档内容,留在脚本里)──
const TITLE_VAGUE_RE = /:\s*(bug|update|improve|fix issue|优化|调整|更新|misc|若干|一些)\s*$/i;

// ── 前置门判定常量(复刻 SKILL.md 1.6.5)──
// 注:check-runs / commit-status / 分支保护(branches/*/protection)端点在本项目 PAT 下常 403,
// 故不逐条读 CI;但 actions/runs 与 rulesets 读得到 —— BLOCKED 时用 classifyHeadChecks 把
// workflow run 分成 awaiting / failed / pending,再用 reviewDecision(权威聚合)区分 review 维度,
// 三类 CI 都空且 review 满足却仍 BLOCKED → 结构性门(永不上报结果的 code_scanning/code_quality 等),
// 靠 admin bypass 合或修门,而不是作者要改(见下方 blockClass='structural-check')。
const PUSHBACK_STRONG_RE = /\[阻断\]|\[必改\]/;
const PUSHBACK_WEAK_RE = /不能合|这次先没合|先没合|需要改后再合|先别合|这次先不合|changes?\s*requested|request\s*changes/i;

// 一次拉全 PR 的讨论 / 时间线(reviewThreads + comments + commits)
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    viewer{ login }
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){ nodes{
          isResolved isOutdated path
          comments(first:50){ nodes{ author{ login __typename } body createdAt } }
        }}
        comments(first:100){ nodes{ author{ login __typename } body createdAt url } }
        timeline: commits(last:100){ nodes{ commit{ committedDate messageHeadline oid } } }
        readyEvents: timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT], last:10){
          nodes{ ... on ReadyForReviewEvent { actor{ login } createdAt } }
        }
      }
    }
  }`;

const isBot = (a) => a?.__typename === 'Bot' || /\[bot\]$/i.test(a?.login ?? '');
const clip = (s, n) => (s ?? '').replace(/\r/g, '').slice(0, n);

// ── --scan-all 批量驱动(见文件头说明;判定本体在下方单 PR 流程,这里只做编排)──
if (process.argv.includes('--scan-all')) {
  const SELF_PATH = fileURLToPath(import.meta.url);
  try {
    const { owner, repo } = parseRepo();
    const slug = `${owner}/${repo}`;
    const rawList = JSON.parse(
      gh(
        ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100', '--json', 'number,title,author,createdAt,isDraft,url'],
        { timeoutMs: 60_000 },
      ).stdout || '[]',
    );
    // 候选口径与 pick.mjs 同源:open 且非 draft,按 createdAt 升序
    const candidates = rawList
      .filter((p) => !p.isDraft)
      .map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? '', createdAt: p.createdAt, url: p.url }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // ── 被 hold 的 draft 预筛(产品/架构门自动放行的入口)──
    // 白名单同意发生在讨论 issue 上、不改 PR 自身状态,所以被 product-hold 转 draft 的 PR
    // 必须主动扫,否则同意永远没机会被消费(作者只能自己标回 ready,违背「同意即自动放行」)。
    // 普通 draft(作者自己转的)照旧跳过;识别靠 PR 评论里的 hold 标记——一条聚合 GraphQL
    // 查所有 draft 的评论做廉价预筛,查失败时退化为「全部 draft 都进扫描」(fail-open:
    // 宁可多扫几条,不可让被 hold 的 PR 被静默饿死)。
    const drafts = rawList
      .filter((p) => p.isDraft)
      .map((p) => ({ number: p.number, title: p.title, author: p.author?.login ?? '', createdAt: p.createdAt, url: p.url }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let heldDraftCandidates = [];
    let heldPrefilterError = null;
    if (drafts.length > 0) {
      try {
        const q = `query{ repository(owner:"${owner}",name:"${repo}"){ ${drafts
          .map((p, i) => `d${i}: pullRequest(number:${p.number}){ number comments(last:100){ nodes{ body } } }`)
          .join(' ')} } }`;
        const repoData = ghGraphql(q, {}, { timeoutMs: 60_000 })?.data?.repository ?? {};
        heldDraftCandidates = drafts.filter((p, i) =>
          (repoData[`d${i}`]?.comments?.nodes ?? []).some((c) => (c.body ?? '').includes(PRODUCT_GATE_MARKER_PREFIX)),
        );
      } catch (e) {
        heldPrefilterError = String(e?.message ?? e).slice(0, 200);
        heldDraftCandidates = drafts; // 预筛失败 → 全量兜底,单 PR 扫描自己会判 held 与否
      }
    }

    // 只读扫描,4 并发安全;单条失败折叠成 ok:false 条目,不炸整批
    const results = await mapPool(candidates, 4, async (c) => {
      const r = await spawnScriptJson(SELF_PATH, [String(c.number), '--scan']);
      return r && r.ok ? r : { ok: false, pr: c.number, error: r?.error ?? '未知失败' };
    });
    // 被 hold 的 draft 同样跑单 PR --scan(输出带 held 字段与 discussionIssue 白名单留言原料);
    // 预筛失败兜底进来的普通 draft 扫完 held=null,主 agent 直接忽略即可
    const heldDraftResults = (await mapPool(heldDraftCandidates, 4, async (c) => {
      const r = await spawnScriptJson(SELF_PATH, [String(c.number), '--scan']);
      return r && r.ok ? r : { ok: false, pr: c.number, error: r?.error ?? '未知失败' };
    })).filter((r) => !r.ok || r.held != null);

    // 空转指纹落盘(供 scheduler pre-check.mjs 比对)。allSkip 必须「全部扫描成功且全为
    // 跳过类」才为 true——任一候选/held draft 扫描失败或预筛失败即 false(「查不了」≠「没活」,
    // 下轮照常起会话)。held draft 本身按跳过类参与 allSkip:它是否可放行取决于讨论 issue
    // 的白名单留言,而 heldIssues(issue updatedAt)已进指纹判据——issue 没动 → 语义判定
    // 结论不变,skip 安全;issue 有新留言 → pre-check 比对失配放行。若会话在「扫描落盘后、
    // 放行动作前」意外挂掉,兜底是 pre-check 的 6h 强制心跳,不会永久饿死。
    // 快照拉取失败只影响省钱(pre-check 拿不到新指纹 → 放行),绝不影响扫描结果本身。
    let scanState = null;
    let scanStateError = null;
    try {
      const snapshot = fetchOpenPrSnapshot({ owner, repo, timeoutMs: 60_000, settleUnknown: true });
      // held draft → 讨论 issue 的 number + updatedAt(pre-check 逐条比对;读不到的记 null,
      // pre-check 视 null 为「不可证不变」→ 放行)
      const heldIssues = heldDraftResults
        .filter((r) => r.ok)
        .map((r) => {
          const d = r.productGate?.discussionIssue ?? r.archGate?.discussionIssue ?? null;
          return { pr: r.pr, number: d?.number ?? r.held?.issueNumber ?? null, updatedAt: d?.updatedAt ?? null };
        });
      scanState = {
        version: 1,
        savedAt: new Date().toISOString(),
        allSkip:
          heldPrefilterError == null &&
          results.every((r) => r.ok && r.auto?.isSkip === true) &&
          heldDraftResults.every((r) => r.ok),
        fingerprint: computePrSetFingerprint(snapshot),
        candidateCount: candidates.length,
        heldIssues,
        prNumbers: snapshot.map((s) => s.number),
      };
      writeFileSync(SCAN_STATE_FILE, JSON.stringify(scanState, null, 2));
    } catch (e) {
      scanStateError = String(e?.message ?? e).slice(0, 200);
    }

    print({
      ok: true,
      scanAll: true,
      repo: { owner, repo },
      candidateCount: candidates.length,
      draftSkipped: rawList.length - candidates.length - heldDraftResults.length,
      candidates,
      scanFailures: [...results, ...heldDraftResults].filter((r) => !r.ok).map((r) => ({ pr: r.pr ?? null, error: r.error })),
      results,
      heldDraftResults,
      ...(heldPrefilterError ? { heldPrefilterError } : {}),
      scanState: scanState
        ? { allSkip: scanState.allSkip, savedAt: scanState.savedAt }
        : { error: scanStateError },
      note: 'results 每条与逐候选跑 `context.mjs <PR> --scan` 的输出逐字段一致(内部就是 spawn 单 PR 模式);ok:false 的条目请单独重跑一次 `context.mjs <PR> --scan` 兜底,仍失败按跳过类记入汇总。heldDraftResults = 被产品/架构门 hold 转 draft 的 PR(held 字段非空):读 discussionIssue.whitelistComments 判白名单是否已明确同意推进——同意 → 跑 product-release.mjs 自动标回 Ready 后按 auto.fallback 归类继续;未同意 → 保持 draft 无需任何动作(不再 hold、不评论)。空转指纹已落盘 .last-scan.json 供 scheduler 预检,skill 流程无需消费该文件',
    });
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const slug = `${owner}/${repo}`;

  // ── 1.1 + 1.3 元数据 / 文件 ──
  const meta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'number,title,body,state,headRefName,headRefOid,isCrossRepository,baseRefName,author,url,mergeable,mergeStateStatus,reviewDecision,isDraft,mergedAt,labels,files',
  ]);
  const title = meta.title ?? '';
  const body = meta.body ?? '';
  const files = (meta.files ?? []).map((f) => ({
    path: f.path,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
  }));
  const totalDiffLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);

  // ── 获取 PR reviews，用于区分 BLOCKED 原因 ──
  // mergeStateStatus=BLOCKED 可能是"需要 approval"，也可能是 CI/冲突。
  // 如果没有 APPROVED 且没有 CHANGES_REQUESTED review → 大概率是"等待 approval"
  const reviewsMeta = ghJson([
    'pr', 'view', String(pr), '--repo', slug,
    '--json', 'reviews',
  ]);
  const prReviews = reviewsMeta.reviews ?? [];
  const changesRequestedReviews = prReviews.filter((r) => r.state === 'CHANGES_REQUESTED');
  const hasChangesRequested = changesRequestedReviews.length > 0;
  // reviewDecision 是 GitHub 按「每个 reviewer 最新一条 review」聚合的权威结论——
  // 用它判 review 维度,而不是 hasChangesRequested(后者只看历史里有没有出现过 CR:
  // 同一 reviewer 先 CHANGES_REQUESTED 后 APPROVED 时,历史里仍有那条 CR,但 reviewDecision
  // 已是 APPROVED。旧逻辑用 hasChangesRequested 会把这种「已被同人 approve 覆盖」误判成
  // 「仍有未解决 CR」,从而把真正的 BLOCKED 成因(结构性必需检查门)说成 review 问题)。
  const reviewDecision = meta.reviewDecision ?? null;
  const type = (title.match(/^(\w+)/)?.[1] ?? '').toLowerCase();
  const titleTypeOk = TITLE_TYPE_RE.test(title);
  const titleVague = TITLE_VAGUE_RE.test(title);
  const isLight = LIGHT_TYPES.includes(type);
  const template = type === 'fix' ? 'bugfix' : isLight ? 'light' : 'feature';
  const wantSections = template === 'bugfix' ? BUGFIX_SECTIONS : template === 'feature' ? FEATURE_SECTIONS : [];
  const sections = {};
  // 段落存在性用标题锚定(^#+ 行内含关键词),不做全文 substring:本仓段落名短
  // (如「风险」),全文 includes 会被正文里"无风险/低风险"之类误命中,硬判层失去拦截力。
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const h of wantSections) sections[h] = new RegExp('^#{1,6}\\s+.*' + escRe(h), 'im').test(body);
  const missingSections = wantSections.filter((h) => !sections[h]);

  // checklist 统计只限 self-review 标题到下一个标题之间的段内复选框——
  // description 别处的普通 TODO 清单(如「后续拆 issue」)不计入分母,防止勾选率被稀释误报。
  const checklistHeading = body.match(/^#+\s*self-review.*$/im);
  let checklistBody = '';
  if (checklistHeading) {
    const rest = body.slice(checklistHeading.index + checklistHeading[0].length);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    checklistBody = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
  }
  const checklistHasSection = checklistHeading != null;
  const checklistTotal = (checklistBody.match(/^\s*- \[[ xX]\]/gm) ?? []).length;
  const checklistDone = (checklistBody.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  const checklistRatio = checklistTotal > 0 ? checklistDone / checklistTotal : 0;

  const redlinePaths = files.map((f) => f.path).filter((p) => REDLINE_PATH_RE.test(p));
  const hitsUpdater = redlinePaths.some((p) => /updater/.test(p));
  // server 改动判定(对应 SKILL「Server 改动确认 gate」:命中则合并必须经 Lizi 确认,auto 不自动合)
  const serverFiles = files.map((f) => f.path).filter((p) => (prRules.serverPaths ?? []).some((prefix) => p.startsWith(prefix)));
  const hitsServer = serverFiles.length > 0;
  const bodyHasOwnerOk = /已和\s*owner\s*确认|owner\s*确认|已确认/i.test(body);
  // CI 配置改动:决定待批 workflow 能否「自动批」(改了 CI 配置的不自动批,详见 approve-workflows.mjs)
  const ciFiles = CI_SENSITIVE_RE ? files.map((f) => f.path).filter((p) => CI_SENSITIVE_RE.test(p)) : [];
  const prTouchesCiFiles = ciFiles.length > 0;

  // formatPass:仅硬判定层(段落实质性 / title 语言 关 3 由 LLM 判,不进此布尔)
  const formatIssues = [];
  if (!titleTypeOk) formatIssues.push('Title 缺少合规 type 前缀(feat/fix/refactor/perf/chore/docs/test/revert/build/ci,格式 `<type>(<scope>): <描述>`)');
  if (titleVague) formatIssues.push('Title 命中含糊词黑名单');
  if (template !== 'light') {
    if (missingSections.length) formatIssues.push(`Description 缺段落: ${missingSections.join(' / ')}`);
    // 本仓 PR 模板(三节制)不含 Self-review Checklist 段——不强制;
    // 作者自发写了 checklist 时才校验勾选率(勾不满说明自检没做完)。
    if (checklistHasSection && checklistTotal > 0 && checklistRatio < 0.8) {
      formatIssues.push(`Self-review 勾选率 ${checklistDone}/${checklistTotal}(<80%)`);
    }
  }
  if (hitsUpdater && !bodyHasOwnerOk) formatIssues.push('命中 cindy-updater 路径但 description 无「已和 owner 确认」(cindy-updater 是高风险模块,改动须经 Lizi 确认,见 docs/dev-rules/cindy-updater.md)[阻断]');
  const formatPass = formatIssues.length === 0;

  // ── 1.5 + 1.6.5:GraphQL 拉历史 ──
  // ghGraphql 容忍 GraphQL 部分成功(某字段被 token 拒时其余字段仍能拿到),作通用兜底。
  const gqlData = ghGraphql(GQL, { owner, repo, num: pr })?.data ?? {};
  const g = gqlData.repository?.pullRequest ?? {};
  const viewerLogin = gqlData.viewer?.login ?? '';
  const authorLogin = meta.author?.login ?? '';
  const isSelfFixAuthor = SELF_FIX_AUTHORS.includes(authorLogin.toLowerCase());

  // 1.5.2 review threads
  const rawThreads = g.reviewThreads?.nodes ?? [];
  const reviewThreads = rawThreads.map((t) => {
    const cs = t.comments?.nodes ?? [];
    return {
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      path: t.path,
      author: cs[0]?.author?.login ?? '(unknown)',
      isBot: isBot(cs[0]?.author),
      count: cs.length,
      lastComment: clip(cs[cs.length - 1]?.body, 300),
    };
  });

  // 1.5.1 issue comments
  const rawComments = g.comments?.nodes ?? [];
  const comments = rawComments.map((c) => ({
    author: c.author?.login ?? '(unknown)',
    isBot: isBot(c.author),
    createdAt: c.createdAt,
    url: c.url,
    body: clip(c.body, 600),
  }));

  // 1.5.3 commits 时间线
  const commits = (g.timeline?.nodes ?? []).map((n) => ({
    oid: (n.commit?.oid ?? '').slice(0, 8),
    date: n.commit?.committedDate,
    headline: n.commit?.messageHeadline,
  }));
  const latestCommitDate = commits.reduce((mx, c) => (c.date > mx ? c.date : mx), '');

  // ── 产品/UI 变更门(确定性部分;「是否真属产品/UI 修改」「issue 里白名单是否同意推进」两项语义
  // 定性留给 LLM,见 SKILL「产品 / UI 变更门」)──
  // 目的:牵涉产品方向 / UI 的改动必须有白名单成员「明确同意推进」才能进自动审;bugfix / 已有功能补充不受限。
  // hold 标记(product-hold.mjs 写入):非空 = 该 PR 被产品/架构门 hold 过。isDraft + 标记非空
  // = 「被 hold 中的 draft」,是自动放行(product-release.mjs)的判定对象——此时无论豁免与否
  // 都要读讨论 issue,主 agent 判出白名单同意后自动标回 Ready,作者无需任何操作。
  const holdMarker = parseLastHoldMarker(rawComments.map((c) => c.body));
  const heldDraft = meta.isDraft === true && holdMarker != null;
  const inWhitelist = (login) => PRODUCT_WHITELIST.includes((login ?? '').toLowerCase());
  const authorInWhitelist = inWhitelist(authorLogin);
  // 白名单 review 清单(信息位,供汇总/定性参考):非 viewer 的白名单成员任意 state 都列;viewer(本流程
  // 自动化账号)只列 APPROVED——自动化自己会以 viewer 身份发 REQUEST_CHANGES(3B 打回),不能当白名单信号。
  const viewerLower = viewerLogin.toLowerCase();
  const whitelistReviews = prReviews
    .filter((r) => {
      const login = (r.author?.login ?? '').toLowerCase();
      if (!inWhitelist(login)) return false;
      return login !== viewerLower || r.state === 'APPROVED';
    })
    .map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt }));
  // 豁免只认「明确同意」:白名单成员在 PR 上点过 Approve(APPROVED)才算;COMMENTED / CHANGES_REQUESTED
  // 只代表「看过 / 有意见」,不代表同意推进(收紧自旧版「任意 review 都算」)。viewer 的 APPROVED 可安全计入:
  // self-approve 只发生在产品门已过、重审通过之后,时序上不可能反向豁免一个被产品门拦着的 PR。
  const whitelistApprovals = whitelistReviews.filter((r) => r.state === 'APPROVED');
  // 最近一次「标回 Ready for review」的操作者:白名单成员点 ready = 明确放行信号。
  // 自动化侧只有 product-release.mjs 会标 ready,且它只在「主 agent 判定讨论 issue 里白名单
  // 已明确同意」之后执行——所以无论该事件来自人肉还是自动放行,语义都是「放行已发生」,
  // viewer 账号的 ready 事件同样可信(转 draft 的 product-hold.mjs 从不标 ready)。
  const readyEvents = (g.readyEvents?.nodes ?? []).map((n) => ({ actor: n.actor?.login ?? '', createdAt: n.createdAt }));
  const latestReadyBy = readyEvents.length ? readyEvents[readyEvents.length - 1].actor : '';
  const readyByWhitelist = latestReadyBy !== '' && inWhitelist(latestReadyBy);
  const uiFiles = files.map((f) => f.path).filter((p) => UI_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)));
  const touchesUi = uiFiles.length > 0;
  const productExempt = authorInWhitelist || whitelistApprovals.length > 0 || readyByWhitelist;
  // 确定性触发器:feat 类型或命中 UI 面路径。命中且未豁免 → auto 走 product-gate,由主 agent 语义定性;
  // fix / 轻档 type 且没碰 UI 面的,直接视为 bugfix / 技术改动,不触发。
  const needsProductCheck = !productExempt && (type === 'feat' || touchesUi);
  // 讨论 issue 的白名单留言(放行主路径的确定性原料;仅命中门的 PR 才查,省 API):
  // 从 PR 评论里 product-hold.mjs 的隐藏标记读出当初开的讨论 issue(取最后一条带 issue= 的标记,与
  // product-hold 口径一致),拉 issue 全部评论、过滤出白名单成员的留言原文。「留言是否构成明确同意推进」
  // 是语义活,由主 agent 判(拿不准从严),脚本只给原料不下结论。viewer 账号在讨论期间不会往 issue 发言
  // (只在 PR 合并后 close 时发),所以 open issue 上 viewer 的留言可视为本人人肉发言,不做 viewer 特判。
  /**
   * 读取该 PR 被 hold 时开的讨论 issue + 其中白名单成员留言(产品门 / 架构门共用——
   * hold 机制是同一套 product-hold.mjs,marker 同前缀,marker 里可带 kind=arch;
   * 唯一差异是「按哪份白名单过滤留言」,由 whitelistFn 注入)。未被 hold 过返回 null。
   */
  function readDiscussionIssue(whitelistFn) {
    const heldIssueUrl = holdMarker?.issueUrl ?? null;
    const issueNum = holdMarker?.issueNumber ?? null;
    if (issueNum) {
      try {
        const issueMeta = ghJson(['issue', 'view', String(issueNum), '--repo', slug, '--json', 'state,comments,updatedAt']);
        // 白名单留言两个来源:① 白名单成员本人直接评论;② Slack 同步 bot 代发的评论——
        // GitHub 作者是 bot,真实发言人在正文「发送者:<名字>」里,拿名字去 org 名录反查
        // GitHub 账号(要求唯一命中)再对白名单。名录只在真的碰到 bot 评论时才加载(省 IO)。
        const whitelistComments = [];
        const unattributedSlackComments = [];
        let rosterErrors = null;
        let rosterCache = null;
        for (const c of issueMeta.comments ?? []) {
          const login = c.author?.login ?? '';
          if (whitelistFn(login)) {
            whitelistComments.push({ author: login, createdAt: c.createdAt, body: clip(c.body, 600) });
            continue;
          }
          if (!SLACK_SYNC_BOTS.includes(normalizeBotLogin(login))) continue;
          // 新版同步署名:「来自 Slack #<频道> · @<GitHub login>(<显示名>)」——直接带 GitHub
          // 账号,零反查即可归属(信任锚仍是 bot 作者本身,普通用户的评论进不了本分支)。
          const inlineLogin = (c.body ?? '').match(/来自\s*Slack[^\n]*?·\s*@([A-Za-z0-9][A-Za-z0-9-]*)/)?.[1] ?? null;
          if (inlineLogin) {
            if (whitelistFn(inlineLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender: inlineLogin, resolvedLogin: inlineLogin.toLowerCase(), resolvedBy: 'inline-login', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue; // 归属已确定:非白名单 = 普通参与讨论者,静默忽略
          }
          // 旧版署名:「发送者:」后是真人名字;冒号全角(：)半角都兼容。两种署名都没有的
          // 同步评论是 AI 机器人自己的回复(如「本评论由 Cindy ... 回复后自动同步而来」),
          // 非人类发言,静默跳过——既不计白名单,也不进 unattributed 刷屏。
          const sender = (c.body ?? '').match(/发送者\s*[:：]\s*([^\n\r]+)/)?.[1]?.trim() ?? null;
          if (!sender) continue;
          // 别名优先(不依赖名录,零 IO):命中即定论,白名单进留言、非白名单静默忽略
          const aliasLogin = SLACK_SENDER_ALIASES[sender.toLowerCase()] ?? null;
          if (aliasLogin) {
            if (whitelistFn(aliasLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin: aliasLogin, resolvedBy: 'alias', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            continue;
          }
          if (!rosterCache) {
            const loaded = loadOrgRosters(prRules.feishuNotify?.orgMappingRepos ?? []);
            rosterCache = loaded.rosters;
            rosterErrors = loaded.fetchErrors.length ? loaded.fetchErrors : null;
          }
          // 名字 → 名录行 → GitHub login:行里必须真解析出 name 且与发送者一致(相等或包含,
          // 兼容「陈祝宇 (Zhuyu)」这类带备注的名录写法),防止名字子串误中别的单元格。
          const logins = new Set();
          for (const { text } of rosterCache) {
            for (const line of text.split('\n')) {
              if (!line.includes('|') || !line.includes(sender)) continue;
              const parsed = parseRosterLine(line);
              if (!parsed?.githubLogin || !parsed.name) continue;
              if (parsed.name === sender || parsed.name.includes(sender)) logins.add(parsed.githubLogin.toLowerCase());
            }
          }
          if (logins.size === 1) {
            const resolvedLogin = [...logins][0];
            if (whitelistFn(resolvedLogin)) {
              whitelistComments.push({ author: login, via: 'slack-sync', sender, resolvedLogin, resolvedBy: 'roster', createdAt: c.createdAt, body: clip(c.body, 600) });
            }
            // 唯一命中但不在白名单 → 普通参与讨论者,静默忽略
          } else {
            // 名录没这人 / 同名多人 → 归属不了,不计白名单也不丢弃信息,交主 agent 酌情上报
            unattributedSlackComments.push({ sender, createdAt: c.createdAt, reason: logins.size === 0 ? 'name-not-in-roster' : 'ambiguous-name', body: clip(c.body, 200) });
          }
        }
        // 归属不了的按发送者去重(同一人刷屏几十条没必要全带),留最新一条 + 总条数
        const unattributedBySender = [...new Map(
          unattributedSlackComments.map((u) => [u.sender, u]),
        ).values()].map((u) => ({
          ...u,
          count: unattributedSlackComments.filter((x) => x.sender === u.sender).length,
          createdAt: unattributedSlackComments.filter((x) => x.sender === u.sender).map((x) => x.createdAt).sort().pop(),
        }));
        return {
          url: heldIssueUrl,
          number: Number(issueNum),
          state: issueMeta.state ?? null,
          updatedAt: issueMeta.updatedAt ?? null,
          whitelistComments,
          ...(unattributedBySender.length ? { unattributedSlackComments: unattributedBySender } : {}),
          ...(rosterErrors ? { rosterErrors } : {}),
        };
      } catch (e) {
        // issue 读不到(被删 / 权限 / 网络)→ 保留 URL 供人工查看,whitelistComments=null 表示「未知」,
        // 主 agent 不得把「未知」当「无同意」直接再 hold 骚扰,应如实进汇总让 owner 看一眼。
        return { url: heldIssueUrl, number: Number(issueNum), state: null, updatedAt: null, whitelistComments: null, error: String(e?.message ?? e).slice(0, 200) };
      }
    }
    return null;
  }

  // held draft 无论豁免与否都读讨论 issue(自动放行需要白名单留言原料 + issue updatedAt 进空转指纹)
  const discussionIssue = needsProductCheck || (heldDraft && holdMarker.kind === 'product')
    ? readDiscussionIssue(inWhitelist)
    : null;
  const productGate = {
    whitelist: prRules.productWhitelist ?? [],
    authorInWhitelist,
    whitelistReviews,
    whitelistApprovals,
    latestReadyBy,
    readyByWhitelist,
    uiFiles,
    touchesUi,
    exempt: productExempt,
    needsProductCheck,
    discussionIssue,
    note: 'exempt=true → 产品门确定性放行(作者在白名单 / 白名单成员在 PR 上点过 Approve(whitelistApprovals)/ 白名单成员把 PR 标回 ready)。needsProductCheck=true → 疑似产品/UI 变更且无确定性放行信号,主 agent 按 SKILL「产品 / UI 变更门」做两步语义判断:① discussionIssue.whitelistComments 非空时先判白名单留言是否明确同意推进——同意 → 按 auto.fallback 继续(视同放行);via=slack-sync 的条目是 Slack 同步消息经 org 名录归属到白名单成员(sender→resolvedLogin)的发言,与本人直接评论同等采信;unattributedSlackComments 非空且内容像同意表态 → 不得采信,进汇总点名让 owner 确认发送者身份;whitelistComments=null(带 error)= issue 读不到,如实进汇总别当「无同意」再 hold;rosterErrors 非空 = 名录读不到、Slack 消息归属可能不完整,同样如实说明。② 未同意 / 无 issue 时再判「是否真属产品/UI 修改」——确属 → product-hold.mjs(自动开讨论 issue + 评论告知作者 + 转 draft);属 bugfix / 已有功能补充 → 按 auto.fallback 继续原流程。两步语义判断拿不准都从严。被 hold 的 draft(顶层 held.heldDraft=true)判出「已同意」或 exempt=true 时 → 跑 product-release.mjs 自动把 PR 标回 Ready(作者无需操作)再继续',
  };

  // ── 技术架构变更门(确定性部分;「是否真属较大架构调整」「issue 里技术白名单是否同意」由 LLM 判,
  // 见 SKILL「技术架构变更门」)。与产品门同机制(hold=product-hold.mjs --kind arch),差异只有三处:
  // 触发器(核心路径改动量 / refactor 大 diff / 超大 diff)、白名单(archGate.whitelist)、语义定性口径。
  // 优先级:产品门 > 架构门——一个 PR 同时命中两门时先走产品门(产品方向都没对齐,技术讨论为时过早);
  // 产品门放行后若仍命中架构门,下一轮再走架构门。
  const inArchWhitelist = (login) => ARCH_WHITELIST.includes((login ?? '').toLowerCase());
  const archAuthorInWhitelist = inArchWhitelist(authorLogin);
  // 白名单 review / ready 放行信号:口径与产品门完全一致(只认 APPROVED / 亲自标 ready)
  const archWhitelistReviews = prReviews
    .filter((r) => {
      const login = (r.author?.login ?? '').toLowerCase();
      if (!inArchWhitelist(login)) return false;
      return login !== viewerLower || r.state === 'APPROVED';
    })
    .map((r) => ({ author: r.author?.login ?? '', state: r.state, submittedAt: r.submittedAt }));
  const archWhitelistApprovals = archWhitelistReviews.filter((r) => r.state === 'APPROVED');
  const readyByArchWhitelist = latestReadyBy !== '' && inArchWhitelist(latestReadyBy);
  // 触发器(任一命中即需语义定性;阈值配置在 pr-rules.json archGate)
  const archCoreFiles = files.filter((f) => ARCH_CORE_PATHS.some((prefix) => f.path.startsWith(prefix)));
  const archCoreDiffLines = archCoreFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const archTriggers = [
    archCoreFiles.length > 0 && archCoreDiffLines >= ARCH_CORE_DIFF_LINES ? `core-paths(核心路径改动 ${archCoreDiffLines} 行 ≥ ${ARCH_CORE_DIFF_LINES})` : null,
    type === 'refactor' && totalDiffLines >= ARCH_REFACTOR_DIFF_LINES ? `refactor-large(refactor 类型且 ${totalDiffLines} 行 ≥ ${ARCH_REFACTOR_DIFF_LINES})` : null,
    totalDiffLines >= ARCH_ANY_DIFF_LINES ? `huge-diff(${totalDiffLines} 行 ≥ ${ARCH_ANY_DIFF_LINES})` : null,
  ].filter(Boolean);
  const archExempt = archAuthorInWhitelist || archWhitelistApprovals.length > 0 || readyByArchWhitelist;
  // 白名单为空 = 功能未启用(archGate 输出 null,auto 分流不包裹)
  const needsArchCheck = ARCH_WHITELIST.length > 0 && !archExempt && archTriggers.length > 0;
  const archDiscussionIssue = (!needsProductCheck && needsArchCheck) || (heldDraft && holdMarker.kind === 'arch')
    ? readDiscussionIssue(inArchWhitelist)
    : null;
  const archGate = ARCH_WHITELIST.length > 0
    ? {
      whitelist: ARCH_RULES.whitelist ?? [],
      authorInWhitelist: archAuthorInWhitelist,
      whitelistReviews: archWhitelistReviews,
      whitelistApprovals: archWhitelistApprovals,
      latestReadyBy,
      readyByWhitelist: readyByArchWhitelist,
      triggers: archTriggers,
      coreFilePaths: archCoreFiles.map((f) => f.path).slice(0, 30),
      coreDiffLines: archCoreDiffLines,
      totalDiffLines,
      exempt: archExempt,
      needsArchCheck,
      discussionIssue: archDiscussionIssue,
      note: 'exempt=true → 架构门确定性放行(作者在技术白名单 / 技术白名单成员 PR 上 Approve 过 / 技术白名单成员把 PR 标回 ready)。needsArchCheck=true → 触发器命中且无放行信号,主 agent 按 SKILL「技术架构变更门」做两步语义判断(口径同产品门,只是判「是否真属较大架构调整」;discussionIssue 的消费规则与 productGate.discussionIssue 完全一致,留言按技术白名单过滤)。产品门优先:needsProductCheck=true 时本门让位(auto 分流只会给 product-gate),下一轮产品门放行后再评估本门',
    }
    : null;

  // ── 1.6.5.1 CI:本脚本不读(见文件头部说明),CI 是否全过由 meta.mergeStateStatus 间接体现 ──

  // ── 1.6.5.2 未解决 conversation(纯布尔,不分作者)──
  const unresolvedThreads = reviewThreads.filter((t) => !t.isResolved);

  // ── head commit 的 workflow run 分类(只在 BLOCKED 时查,省掉正常 PR 的额外 API)──
  // classifyHeadChecks 一次拉 actions/runs 得到 awaiting / failed / pending:
  //   - awaiting:fork / 首次贡献者 workflow 待批准才能跑(required check 没报告)。这与
  //     blockedAwaitingApproval(缺 reviewer approval)是两个不同的 BLOCKED 来源,不要混;
  //     真批由 approve-workflows.mjs 做,这里只探测供 1.7 报告 + auto 分流。
  //   - failed / pending:真失败 / 还在跑,用于 BLOCKED 细分。
  // 权限/网络异常降级为 ciRuns=null(未知),绝不炸掉 context。
  const { ciRuns } = meta.mergeStateStatus === 'BLOCKED'
    ? classifyHeadChecks(slug, meta.headRefOid)
    : { ciRuns: null };
  const workflowsAwaitingApproval = ciRuns ? ciRuns.awaiting : null; // null=未查/查不到;[]=无;非空=待批清单
  const hasWorkflowsAwaiting = Array.isArray(workflowsAwaitingApproval) && workflowsAwaitingApproval.length > 0;
  const ciFailed = ciRuns ? ciRuns.failed : [];
  const ciPending = ciRuns ? ciRuns.pending : [];

  // ── 自解死锁判定:BLOCKED 仅因「viewer(本流程账号)自己挂的 CHANGES_REQUESTED」而起,
  // 且所有 conversation 都已 resolve。这是 auto 流程自己 3B 打回后、作者改完 resolve、
  // 但旧 CR review 没撤导致 reviewDecision 永远 CHANGES_REQUESTED → BLOCKED → skip-gate
  // 永远跳过的死锁。命中时这条 CR 不计入硬 blocker:走重审,审查子 agent 逐条核实问题
  // 真被改了(历史承接),再由合并阶段同身份 self-approve 覆盖掉自己的 CR 解锁。
  // ⚠️ 只要掺了「别人」的 CR(allChangesRequestedBySelf=false)、或还有 thread 没 resolve,
  // 就不命中 → 照旧硬拦,绝不替别人撤 review。
  const allChangesRequestedBySelf =
    hasChangesRequested && viewerLogin !== '' &&
    changesRequestedReviews.every((r) => (r.author?.login ?? '') === viewerLogin);
  const selfBlockedResolvable =
    meta.mergeStateStatus === 'BLOCKED' &&
    meta.reviewDecision === 'CHANGES_REQUESTED' &&
    allChangesRequestedBySelf &&
    unresolvedThreads.length === 0;

  // ── 1.6.5.3 评论类:bot 总结评论 + reviewer 历史打回(issue comment 形式)──
  const botComments = comments
    .filter((c) => c.isBot)
    .map((c) => ({ author: c.author, createdAt: c.createdAt, url: c.url, snippet: clip(c.body, 800) }));
  const reviewerPushbacks = comments
    .filter((c) => !c.isBot && c.author !== authorLogin)
    .map((c) => {
      const strong = PUSHBACK_STRONG_RE.test(c.body);
      const weak = PUSHBACK_WEAK_RE.test(c.body);
      if (!strong && !weak) return null;
      return {
        author: c.author,
        createdAt: c.createdAt,
        url: c.url,
        signal: strong ? 'strong' : 'weak',
        hasNewerCommit: latestCommitDate ? latestCommitDate > c.createdAt : false,
        snippet: clip(c.body, 400),
      };
    })
    .filter(Boolean);

  // ── 1.6.5.4 前置门结论 ──
  const blockers = [];
  // workflow 待批准导致的 BLOCKED 单独标记:这是「待 approve 才能跑 CI」而非「作者要改」,
  // 解法是 approve workflow(由 owner / auto 放行),不是打回作者。它仍是 blocker(现在确实不可合),
  // 但 auto 路由要把它和「真要作者处理」的 blocker 区分开 → 走 approve-workflows 而非 skip-gate。
  const WORKFLOW_AWAIT_BLOCKER = hasWorkflowsAwaiting
    ? `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(approve 后 CI 跑完即可解除 BLOCKED)`
    : null;
  // mergeStateStatus 区分:DIRTY=冲突(硬拦);BLOCKED=用 reviewDecision(权威)+ CI run 分类细分。
  // blockClass 把 BLOCKED 成因显式分档,供 1.7 报告 / auto 分流 / 3A bypass 决策共用。
  let blockClass = 'none';
  let structuralBlock = null; // 结构性门(永不上报的必需检查)详情:{requiredCheckRules, canBypass, rulesetIds} | null
  if (meta.mergeStateStatus === 'DIRTY') {
    blockers.push('mergeStateStatus=DIRTY(有冲突)');
    blockClass = 'conflict';
  } else if (meta.mergeStateStatus === 'BLOCKED') {
    if (WORKFLOW_AWAIT_BLOCKER) {
      // BLOCKED 根因已确定是 fork workflow 待批准(required check 没报告)——专属文案,不走泛化分类。
      blockers.push(WORKFLOW_AWAIT_BLOCKER);
      blockClass = 'workflow-awaiting';
    } else if (reviewDecision === 'CHANGES_REQUESTED') {
      if (selfBlockedResolvable) {
        // 死锁:仅 viewer 自己挂的 CR、且 thread 全 resolve。不计硬 blocker——走重审核实问题真被改了,
        // 再由合并阶段 self-approve 解锁(见 selfBlockedResolvable 注释)。
        blockClass = 'self-resolvable';
      } else {
        blockers.push('mergeStateStatus=BLOCKED(reviewDecision=CHANGES_REQUESTED,仍有 reviewer 要求修改)');
        blockClass = 'review-changes-requested';
      }
    } else if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision == null) {
      // 缺 approval(含刚 approve 完 GitHub 还在重算)→ 不视硬 blocker,审查通过后提交 APPROVE 即解除。
      blockClass = 'awaiting-approval';
    } else if (unresolvedThreads.length > 0) {
      // reviewDecision=APPROVED 但仍有 thread 没 resolve → BLOCKED 很可能来自 ruleset 的
      // required_review_thread_resolution。blocker 由下面 unresolvedThreads 统一押,这里只定 class。
      blockClass = 'threads-unresolved';
    } else if (ciFailed.length > 0) {
      // 有 workflow run 真失败 → 真 blocker(该打回 / 不合)。
      blockers.push(`mergeStateStatus=BLOCKED(CI 失败:${ciFailed.join(' / ')})`);
      blockClass = 'ci-failed';
    } else if (ciPending.length > 0) {
      // workflow run 还在跑 → 等跑完再合(transient,auto 下轮重试,别打回作者)。
      blockers.push(`mergeStateStatus=BLOCKED(CI 还在跑:${ciPending.join(' / ')},等跑完即可)`);
      blockClass = 'ci-pending';
    } else {
      // review 满足(APPROVED)+ 线程已 resolve + 无失败/进行中/待批的 workflow run,但仍 BLOCKED
      // → 残留的是「永不上报结果的必需检查门」:典型 org ruleset 的 code_scanning(CodeQL)/
      // code_quality(本仓库根本没产出对应结果),或被 job 级 if 跳过的必需 check。
      // 这类不是作者要改 —— 要么 owner 用 admin bypass 合、要么修该门让它能上报结果。
      blockClass = 'structural-check';
      structuralBlock = probeBranchProtection(slug, meta.baseRefName);
      const ruleHint = structuralBlock?.requiredCheckRules?.length
        ? structuralBlock.requiredCheckRules.join(' / ')
        : 'code_scanning / code_quality 等';
      const bypassHint = structuralBlock?.canBypass && structuralBlock.canBypass !== 'never'
        ? `当前账号可 bypass(${structuralBlock.canBypass})`
        : 'bypass 权限未知';
      blockers.push(
        `mergeStateStatus=BLOCKED(必需检查门「${ruleHint}」未上报结果;review 与已跑 CI 均无问题——非作者可处理,需 admin bypass 合或修该门;${bypassHint})`,
      );
    }
  }
  if (unresolvedThreads.length) blockers.push(`${unresolvedThreads.length} 条 conversation 未 resolve(不分作者)`);
  // reviewer 强信号打回 + 之后零新 commit = 确定未解决,硬列
  const hardPushbacks = reviewerPushbacks.filter((p) => p.signal === 'strong' && !p.hasNewerCommit);
  if (hardPushbacks.length) blockers.push(`${hardPushbacks.length} 条 reviewer 打回([阻断]/[必改])之后零新 commit`);

  // softFlags:需要 LLM 读内容定性的项(不直接判死,但不能无脑放行)
  const softFlags = [];
  if (blockClass === 'awaiting-approval') {
    softFlags.push('mergeStateStatus=BLOCKED(缺少 reviewer approval，审查通过后可先提交 APPROVE review 再合并)');
  }
  if (botComments.length) softFlags.push(`${botComments.length} 条 bot / 工具账号评论,需读内容判断是不是要处理的问题`);
  const softPushbacks = reviewerPushbacks.filter((p) => !(p.signal === 'strong' && !p.hasNewerCommit));
  if (softPushbacks.length) softFlags.push(`${softPushbacks.length} 条疑似 / 已有新 commit 的 reviewer 打回,需逐条核实改没改`);

  const gatePass = blockers.length === 0;

  // ── auto 模式分流(把 SKILL「候选轮转」的「跳过 vs 处理」判定代码化)──
  // 仅 auto 模式消费;交互模式忽略 auto.*、仍走用户拍板。
  // 优先级与 skill 流程一致:格式门(1.2)在前置门(1.6.5)之前——formatPass=false 时
  // 根本不评估 gate(1.2.5 直接走 3B)。
  // 「stale 打回」= 该 PR 之前被打回过、且作者在最近一次打回后没提新 commit → 再打回没意义,
  // 跳过等作者动。打回时间取两类来源的最晚值:
  //   ① CHANGES_REQUESTED review 的 submittedAt(新机制:3B 用 REQUEST_CHANGES,含纯格式门
  //      打回那种 only-body review —— 它不进 issue comments 也不产生 reviewThread,只有这里能抓到);
  //   ② 旧 issue-comment 形式打回 reviewerPushbacks 的 createdAt(历史遗留)。
  const pushbackDates = [
    ...prReviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.submittedAt),
    ...reviewerPushbacks.map((p) => p.createdAt),
  ].filter(Boolean);
  const latestPushbackDate = pushbackDates.sort().pop() ?? '';
  const wasPushedBack = latestPushbackDate !== '';
  const authorActedSincePushback =
    wasPushedBack && latestCommitDate !== '' && latestCommitDate > latestPushbackDate;
  const hasStalePushback = wasPushedBack && !authorActedSincePushback;

  let autoAction, autoReason, autoSkip;
  if (!formatPass) {
    if (hasStalePushback) {
      autoAction = 'skip-stale-pushback';
      autoReason = '格式门未通过,但上次已打回、作者未提交新 commit,跳过';
      autoSkip = true;
    } else {
      autoAction = 'pushback-format';
      autoReason = '格式门未通过且未被打回过(或打回后已有新 commit),走 3B 提交 REQUEST_CHANGES';
      autoSkip = false;
    }
  } else if (!gatePass) {
    // 若 gate 未过的「唯一」原因就是 workflow 待批准(除它之外没有别的 blocker)→ 不是打回作者,
    // 而是放行 CI:没改 CI 配置就自动 approve、改了就跳过让 owner 手动批。
    // 否则(还有未 resolve thread / 冲突 / 别人的 CR 等真要先处理的 blocker)→ 照旧 skip-gate,
    // CI 批准可以等那些处理完再说。
    const otherBlockers = WORKFLOW_AWAIT_BLOCKER ? blockers.filter((b) => b !== WORKFLOW_AWAIT_BLOCKER) : blockers;
    if (hasWorkflowsAwaiting && otherBlockers.length === 0) {
      const names = workflowsAwaitingApproval.map((w) => w.name).join(' / ');
      if (prTouchesCiFiles) {
        autoAction = 'skip-workflow-ci-change';
        autoReason = `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(${names}),但该 PR 改了 CI 配置(${ciFiles.join(' / ')})——不自动批,需人工 approve`;
        autoSkip = true;
      } else {
        autoAction = 'approve-workflows';
        autoReason = `${workflowsAwaitingApproval.length} 个 workflow 待批准才能跑 CI(${names}),未改 CI 配置——自动 approve 放行 CI(下一轮 CI 跑完再审 / 合)`;
        autoSkip = false;
      }
    } else if (blockClass === 'structural-check') {
      // 结构性 BLOCKED:review + 已跑 CI 都没问题,只卡在永不上报的必需检查门(code_scanning/code_quality 等)。
      if (structuralBlock && (structuralBlock.canBypass === 'always' || structuralBlock.canBypass === 'pull_requests')) {
        // 当前账号有 bypass 权限,auto 模式直接走 admin bypass 合并(安全前提:review APPROVED + 已跑 CI 无失败 + 0 未 resolve thread)
        autoAction = 'bypass-structural-block';
        autoReason = `结构性 BLOCKED(${structuralBlock.requiredCheckRules.join('/')} 永不上报结果),当前账号可 bypass——自动 admin bypass 合并`;
        autoSkip = false;
      } else {
        // 没有 bypass 权限,只能跳过通知 owner
        autoAction = 'skip-structural-block';
        autoReason = `结构性 BLOCKED(非作者可处理,当前账号无 bypass 权限):${blockers.join(';')}`;
        autoSkip = true;
      }
    } else {
      autoAction = 'skip-gate';
      // 拼上具体 blockers,飞书汇总行直接用得上(别只写泛化的「前置门未通过」)
      autoReason = `前置门未通过:${blockers.join(';')}`;
      autoSkip = true;
    }
  } else {
    autoAction = 'review';
    autoReason = selfBlockedResolvable
      ? '前置门唯一阻塞是 viewer 自己挂的 CHANGES_REQUESTED 且 thread 全 resolve;进入重审,通过后 self-approve 解锁再合并'
      : '格式门 + 前置门均通过,进入代码审查';
    autoSkip = false;
  }

  // ── 产品/UI 门包裹(优先级最高,压过格式门 / 前置门):疑似产品/UI 且无白名单放行信号时,
  // 先让人肉讨论——格式 / gate 问题等放行回流后由 fallback 之外的下一轮正常拦。原走向存进
  // auto.fallback:主 agent 语义定性「不属产品/UI 修改」时按 fallback 继续,不用重推。
  // (gateFallback 为产品门 / 架构门共用——两门互斥包裹,产品门优先,见 archGate 注释。)
  let gateFallback = null;
  if (needsProductCheck) {
    gateFallback = { action: autoAction, reason: autoReason, isSkip: autoSkip };
    const trigger = [
      type === 'feat' ? 'feat 类型' : '',
      touchesUi ? `命中 UI 路径(${uiFiles.slice(0, 3).join(' / ')}${uiFiles.length > 3 ? ' 等' : ''})` : '',
    ].filter(Boolean).join(' + ');
    autoAction = 'product-gate';
    const issueHint = discussionIssue
      ? (discussionIssue.whitelistComments === null
        ? `;已有讨论 issue(${discussionIssue.url})但评论读取失败,如实进汇总让 owner 看,别当「无同意」再 hold`
        : `;已有讨论 issue(${discussionIssue.url}),白名单留言 ${discussionIssue.whitelistComments.length} 条${discussionIssue.unattributedSlackComments?.length ? `、另有 ${discussionIssue.unattributedSlackComments.length} 条 Slack 同步消息归属不了发送者(不得当白名单同意采信)` : ''}——先判白名单留言是否明确同意推进,同意 → 按 auto.fallback 继续(视同放行)`)
      : '';
    autoReason = `疑似产品/UI 变更(${trigger}),作者 ${authorLogin} 非白名单且无确定性放行信号(白名单 PR Approve / 标回 ready)${issueHint}。未同意 / 无 issue 时语义定性:确属产品/UI → product-hold(自动开讨论 issue + 评论告知作者 + 转 draft);属 bugfix/已有功能补充 → 按 auto.fallback 继续`;
    autoSkip = false;
  }

  // ── 技术架构门包裹(优先级低于产品门:needsProductCheck 时不包裹,见 archGate 注释)──
  if (!needsProductCheck && needsArchCheck) {
    gateFallback = { action: autoAction, reason: autoReason, isSkip: autoSkip };
    autoAction = 'arch-gate';
    const archIssueHint = archDiscussionIssue
      ? (archDiscussionIssue.whitelistComments === null
        ? `;已有讨论 issue(${archDiscussionIssue.url})但评论读取失败,如实进汇总让 owner 看,别当「无同意」再 hold`
        : `;已有讨论 issue(${archDiscussionIssue.url}),技术白名单留言 ${archDiscussionIssue.whitelistComments.length} 条${archDiscussionIssue.unattributedSlackComments?.length ? `、另有 ${archDiscussionIssue.unattributedSlackComments.length} 条 Slack 同步消息归属不了发送者(不得当同意采信)` : ''}——先判留言是否明确同意推进,同意 → 按 auto.fallback 继续(视同放行)`)
      : '';
    autoReason = `疑似较大技术架构调整(${archTriggers.join(' + ')}),作者 ${authorLogin} 非技术白名单且无放行信号(技术白名单 PR Approve / 标回 ready)${archIssueHint}。未同意 / 无 issue 时语义定性:确属较大架构调整 → product-hold --kind arch(自动开技术讨论 issue + 评论告知作者 + 转 draft);属局部实现/普通改动/机械性大 diff → 按 auto.fallback 继续`;
    autoSkip = false;
  }

  const scanMode = process.argv.includes('--scan');
  if (scanMode) {
    // 精简输出:无 body / 历史全文(见文件头 --scan 说明)。字段增删要同步 SKILL「候选批处理」阶段 1。
    print({
      ok: true,
      pr,
      scan: true,
      repo: { owner, repo },
      meta: {
        number: meta.number,
        title,
        state: meta.state,
        isDraft: meta.isDraft,
        mergedAt: meta.mergedAt,
        author: authorLogin,
        baseRefName: meta.baseRefName,
        headRefOid: meta.headRefOid,
        url: meta.url,
        mergeStateStatus: meta.mergeStateStatus,
        reviewDecision: meta.reviewDecision,
      },
      filePaths: files.map((f) => f.path),
      totalDiffLines,
      held: holdMarker ? { ...holdMarker, heldDraft } : null,
      format: { formatPass, formatIssues, hitsServer },
      gate: {
        gatePass,
        blockClass,
        blockers,
        softFlags,
        unresolvedThreadCount: unresolvedThreads.length,
      },
      productGate,
      archGate,
      auto: {
        action: autoAction,
        reason: autoReason,
        isSkip: autoSkip,
        fallback: gateFallback,
        needsSelfApproval: autoAction === 'review' && selfBlockedResolvable,
        selfFix: isSelfFixAuthor,
      },
      note: 'scan 精简输出,仅供 auto 批处理阶段 1 扫描分类与汇总;需要 body / 历史全文时对该 PR 单独跑不带 --scan 的全量模式(审查子 agent 在自己 worktree 里自取,别在主 session 拉全量)',
    });
  } else {
  print({
    ok: true,
    pr,
    repo: { owner, repo },
    meta: {
      number: meta.number,
      title,
      state: meta.state,
      isDraft: meta.isDraft,
      mergedAt: meta.mergedAt,
      author: authorLogin,
      headRefName: meta.headRefName,
      headRefOid: meta.headRefOid,
      baseRefName: meta.baseRefName,
      url: meta.url,
      mergeable: meta.mergeable,
      mergeStateStatus: meta.mergeStateStatus,
      reviewDecision: meta.reviewDecision,
      labels: (meta.labels ?? []).map((l) => l.name),
      body,
    },
    files,
    totalDiffLines,
    held: holdMarker ? { ...holdMarker, heldDraft } : null,
    format: {
      type,
      template,
      titleTypeOk,
      titleVague,
      sections,
      missingSections,
      checklist: { hasSection: checklistHasSection, total: checklistTotal, done: checklistDone, ratio: Number(checklistRatio.toFixed(2)) },
      redlinePaths,
      hitsUpdater,
      hitsServer,
      serverFiles,
      formatPass,
      formatIssues,
      note: 'formatPass=false 一定不合规;true 仍需 LLM 判段落是否实质、title 语言(关 3)',
    },
    history: { comments, reviewThreads, commits, latestCommitDate },
    productGate,
    archGate,
    gate: {
      unresolvedThreads,
      reviewerPushbacks,
      botComments,
      blockers,
      softFlags,
      blockClass,
      structuralBlock,
      ciRuns,
      blockedAwaitingApproval: blockClass === 'awaiting-approval',
      workflowsAwaitingApproval,
      prTouchesCiFiles,
      ciFiles,
      selfBlockedResolvable,
      gatePass,
      note: 'gatePass=false → 1.7 必须卡 gate;softFlags 里的项由 LLM 读内容定性,别无脑放行。blockClass 是 BLOCKED 成因分档:conflict / workflow-awaiting(fork 待批 CI)/ review-changes-requested(reviewDecision=CHANGES_REQUESTED,真要作者改)/ self-resolvable(仅 viewer 自己的 CR、thread 全 resolve)/ awaiting-approval(缺 approve,审查通过后提交 APPROVE 即解)/ threads-unresolved / ci-failed(workflow 真失败)/ ci-pending(还在跑)/ structural-check(review+已跑 CI 都过、仍 BLOCKED——永不上报的必需检查门 code_scanning/code_quality 等,需 admin bypass 合或修门,非作者可处理)。structuralBlock(仅 structural-check 时非空):{requiredCheckRules, canBypass, rulesetIds},canBypass=always/pull_requests 表示当前账号可 admin bypass。ciRuns(仅 BLOCKED 时查,null=未知):{failed,pending,awaiting,all}。workflowsAwaitingApproval=ciRuns.awaiting(fork 待批 workflow)。与 blockedAwaitingApproval(缺 reviewer approval)是两回事',
    },
    auto: {
      action: autoAction,
      reason: autoReason,
      isSkip: autoSkip,
      fallback: gateFallback,
      needsSelfApproval: autoAction === 'review' && selfBlockedResolvable,
      selfFix: isSelfFixAuthor,
      wasPushedBack,
      latestPushbackDate,
      note: 'selfFix=true→作者在 selfFixAuthors 名单(pr-rules.json):该 PR 卡在作者侧问题(pushback-format / 审查不通过 / skip-gate 冲突·未 resolve·CI 失败 / skip-stale-pushback)时不打回不催办,改走 SKILL「自动跟进修复(fix-handoff)」开跟进会话自己修(own-pr 无法 REQUEST_CHANGES)。auto 模式分流(交互模式忽略本字段):isSkip=true→跳过类(扫描不 checkout,无需清理);isSkip=false→进本轮处理清单,受 BATCH_MAX 名额约束(pushback-format 直接 3B / review 起审查子 agent 并行审 / approve-workflows 调 approve-workflows.mjs / bypass-structural-block 走 admin bypass 合并 / product-gate、arch-gate 主 agent 语义定性后 product-hold(arch 加 --kind arch)或按 fallback 继续),详见 SKILL「候选批处理」「产品 / UI 变更门」「技术架构变更门」。action ∈ {review, pushback-format, product-gate, arch-gate, skip-gate, skip-stale-pushback, approve-workflows, skip-workflow-ci-change, bypass-structural-block, skip-structural-block}。product-gate=疑似产品/UI 变更且无白名单明确同意信号(确定性信号=白名单 PR Approve / 标回 ready;有讨论 issue 时先语义判 productGate.discussionIssue.whitelistComments 是否明确同意推进,同意→按 fallback 继续,见 productGate 字段),fallback 存被包裹前的原走向。arch-gate=疑似较大技术架构调整且无技术白名单放行信号(消费规则同 product-gate,读 archGate 字段;产品门优先,两门不会同时出现)。approve-workflows=fork workflow 待批且未改 CI 配置→自动 approve 放行 CI(下一轮 CI 跑完再审);skip-workflow-ci-change=待批但改了 CI 配置→跳过、飞书点名让 owner 手动批;bypass-structural-block=结构性 BLOCKED + 当前账号可 bypass→auto 模式直接 gh pr merge --admin 合并(安全前提:reviewDecision=APPROVED + 已跑 CI 无失败 + 0 未 resolve thread);skip-structural-block=结构性 BLOCKED 但当前账号无 bypass 权限→跳过、飞书点名让 owner 处理。needsSelfApproval=true→该 PR 唯一阻塞是 viewer 自己挂的 CR、重审通过后合并前须先 gh pr review --approve 撤掉自己的 CR 再合(见 SKILL 3A)',
    },
  });
  }
} catch (e) {
  fail(e);
}
