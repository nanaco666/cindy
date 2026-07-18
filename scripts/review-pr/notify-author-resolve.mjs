#!/usr/bin/env node
// notify-author-resolve.mjs — auto 模式因「未 resolve thread」跳过某 PR 时,在该 PR 上
// 发一条评论 @作者,催其去 GitHub 点 Resolve。带去重:同一批未 resolve thread 只评一次。
//
// 为什么单独成脚本(而非塞进 context.mjs):
//   - context.mjs 是「只读 + 客观判定」核心,绝不发评论 / 不改外部状态;发评论是对外
//     写操作,集中在这里,职责清晰。
//   - 去重 + 发评论 + 记录指纹必须原子绑定:评论真发出去了才记「已催」,发失败则下轮重试,
//     不会因为提前记状态而漏催。把这套逻辑放一个脚本里最稳。
//
// 去重粒度(= 未 resolve thread 集合指纹):指纹 = 当前未 resolve thread 的 GraphQL id
// 排序拼接。持久化在 .reminded.json = { "<pr>": "<指纹>" }(gitignored)。
//   - 指纹与上次记录相同 → 这批 thread 已经催过 → 静默不发(posted=false)。
//   - 指纹变了(作者新增 thread / 部分 resolve / 首次)→ 发评论 + 记新指纹。
//   - 没有任何未 resolve thread → 不发,清掉该 PR 状态(下次再卡会重新催)。
//
// 退出码恒 0(脚本自身异常才 1):结果全在 JSON 字段(posted / reason),不靠退出码分流,
// 让 auto 轮转能继续跑下一候选。
//
// 跑:node scripts/review-pr/notify-author-resolve.mjs <PR...> [--dry-run]
//   --dry-run:打印将发的评论与判定,但不真发评论、不写状态(供调试 / 自测)。
//   多个 PR 号:批量模式,逐个 spawn 自身聚合输出 { batch:true, results:[…] }——
//   核心判定 / 去重逻辑零改动(就是跑单 PR 模式),单 PR 输出保持原样完全兼容。
//   批量**必须串行**(mapPool 并发 1):共享 .reminded.json 去重状态,并发会读写竞态。

import { parseRepo, parsePR, gh, ghGraphql, print, fail, spawnScriptJson, mapPool } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── 批量驱动(见文件头)──
{
  const prArgs = process.argv.slice(2).filter((a) => /^#?\d+$/.test(a));
  if (prArgs.length > 1) {
    const flags = process.argv.slice(2).filter((a) => !/^#?\d+$/.test(a)); // --dry-run 等原样透传
    const SELF = fileURLToPath(import.meta.url);
    const results = await mapPool(prArgs, 1, (p) => spawnScriptJson(SELF, [p, ...flags]));
    print({ ok: true, batch: true, count: results.length, results });
    process.exit(0);
  }
}

const REMIND_FILE = new URL('.reminded.json', import.meta.url);

// 只拉 review thread(id / isResolved / path)+ 作者,够算指纹和 @人 即可,轻量。
const GQL = `
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        author{ login }
        reviewThreads(first:100){ nodes{ id isResolved path } }
      }
    }
  }`;

function readState() {
  try {
    return JSON.parse(readFileSync(REMIND_FILE, 'utf8')) || {};
  } catch {
    return {}; // 文件不存在 / 损坏都按空状态起步
  }
}

function writeState(state) {
  try {
    writeFileSync(REMIND_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort:写失败最多下轮重复催一次,不影响主流程 */
  }
}

try {
  const { owner, repo } = parseRepo();
  const pr = parsePR(process.argv[2]);
  const prKey = String(pr);
  const dryRun = process.argv.includes('--dry-run');
  const slug = `${owner}/${repo}`;

  const data = ghGraphql(GQL, { owner, repo, num: pr })?.data?.repository?.pullRequest ?? {};
  const author = data.author?.login ?? '';
  const threads = data.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);

  const state = readState();

  // 没有未 resolve thread:无需催,清掉本 PR 状态(让下次再卡时重新催)
  if (unresolved.length === 0) {
    if (state[prKey] !== undefined && !dryRun) {
      delete state[prKey];
      writeState(state);
    }
    print({ ok: true, pr, posted: false, reason: 'no-unresolved-threads', author });
  } else {
    const fingerprint = unresolved.map((t) => t.id).sort().join(',');

    // 同一批 thread 已催过 → 静默
    if (state[prKey] === fingerprint) {
      print({ ok: true, pr, posted: false, reason: 'already-commented', author, fingerprint });
    } else {
      const paths = [...new Set(unresolved.map((t) => t.path).filter(Boolean))];
      const pathHint = paths.length
        ? `(${paths.slice(0, 5).join(' / ')}${paths.length > 5 ? ' 等' : ''})`
        : '';
      const mention = author ? `@${author} ` : '';
      const body =
        `${mention}👋 这个 PR 还有 ${unresolved.length} 条 review conversation 没 resolve${pathHint},` +
        `auto-review 因此暂时跳过、没法继续审查 / 合并。\n\n` +
        `如果你已经按评论改完或回应了,请到对应 thread 上点 **Resolve conversation**;` +
        `全部 resolve 后,下一轮 auto-review 会自动重新审查这个 PR。`;

      if (dryRun) {
        print({ ok: true, pr, posted: false, reason: 'dry-run', author, fingerprint, body });
      } else {
        // 发评论:body 走 stdin(--body-file -),避免中文 / 特殊字符的命令行引号问题
        const r = gh(['pr', 'comment', prKey, '--repo', slug, '--body-file', '-'], {
          input: body,
          allowFail: true,
        });
        if (r.ok) {
          state[prKey] = fingerprint;
          writeState(state);
          print({ ok: true, pr, posted: true, author, fingerprint, unresolvedCount: unresolved.length });
        } else {
          // 发失败不记状态,下轮重试
          print({ ok: true, pr, posted: false, reason: 'comment-failed', author, error: (r.stderr || '').trim().slice(0, 300) });
        }
      }
    }
  }
} catch (e) {
  fail(e);
}
