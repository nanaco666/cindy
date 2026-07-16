import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  projectToCategory,
  registerGeneratedTools,
  type LarkGenToolDef,
} from '../mcp/genTools.js';
import { FeishuToolRegistry } from '../mcp/toolRegistry.js';
import type { FeishuApiResult } from '../../types.js';

const callOpenApi = vi.fn(async () => ({ ok: true, data: {} }) as FeishuApiResult);
const fmt = (r: FeishuApiResult) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(r) }],
});

function def(over: Partial<LarkGenToolDef>): LarkGenToolDef {
  return {
    project: 'vc',
    name: 'x',
    sdkName: 'x',
    path: '/open-apis/x',
    httpMethod: 'GET',
    description: 'd',
    accessTokens: ['tenant', 'user'],
    schema: { params: z.object({}).optional() },
    ...over,
  };
}

describe('registerGeneratedTools', () => {
  it('registers user-token defs, skips tenant-only and premium collisions', () => {
    const registry = new FeishuToolRegistry();
    // Pre-register a hand-written premium tool that a generated def will collide with.
    registry.registerRaw({
      name: 'minutes_search',
      category: 'minutes',
      description: 'premium',
      inputShape: {},
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });

    const defs: LarkGenToolDef[] = [
      def({ name: 'vc.v1.meetingRecording.get', project: 'vc' }), // ✓ register
      def({ name: 'admin.v1.badgeImage.create', project: 'admin', accessTokens: ['tenant'] }), // ✗ tenant-only
      def({ name: 'minutes_search', project: 'minutes' }), // ✗ collides with premium
      def({ name: 'docs.v1.content.get', project: 'docs' }), // ✓ register, alias→docx
    ];

    const stats = registerGeneratedTools(registry, callOpenApi, fmt, { defs });

    expect(stats).toEqual({ registered: 2, skipped: 2 });
    expect(registry.has('vc.v1.meetingRecording.get')).toBe(true);
    expect(registry.has('admin.v1.badgeImage.create')).toBe(false);
    // premium tool untouched (still the premium description, not shadowed)
    expect(registry.get('minutes_search')?.description).toBe('premium');
    // docs project aliased into the docx category bucket
    expect(registry.get('docs.v1.content.get')?.category).toBe('docx');
    // vc passes through unchanged
    expect(registry.get('vc.v1.meetingRecording.get')?.category).toBe('vc');
  });

  it('default policy: registers only read-only (GET) tools in collaboration domains', () => {
    const registry = new FeishuToolRegistry();
    const defs: LarkGenToolDef[] = [
      def({ name: 'vc.v1.meeting.get', project: 'vc', httpMethod: 'GET' }), // ✓ read + collab
      def({ name: 'minutes.v1.minute.get', project: 'minutes', httpMethod: 'GET' }), // ✓ read + collab
      def({ name: 'task.v2.task.get', project: 'task', httpMethod: 'GET' }), // ✓ read + collab (task:task:read requested)
      def({ name: 'im.v1.message.delete', project: 'im', httpMethod: 'DELETE' }), // ✗ mutating
      def({ name: 'calendar.v4.event.create', project: 'calendar', httpMethod: 'POST' }), // ✗ mutating
      def({ name: 'payroll.v1.payment.list', project: 'payroll', httpMethod: 'GET' }), // ✗ sensitive domain
      // directory aliases into the `contact` category, but the allow-list is keyed
      // on the RAW project, so it stays excluded:
      def({ name: 'directory.v1.employee.list', project: 'directory', httpMethod: 'GET' }), // ✗ sensitive domain
      // `search` was dropped from the allow-list (its real GET tools are all
      // tenant-only, so it would never advertise anything under user-token):
      def({ name: 'search.v2.dataSource.get', project: 'search', httpMethod: 'GET' }), // ✗ not in allow-list
    ];
    const stats = registerGeneratedTools(registry, callOpenApi, fmt, { defs });
    expect(stats).toEqual({ registered: 3, skipped: 5 });
    expect(registry.has('vc.v1.meeting.get')).toBe(true);
    expect(registry.has('minutes.v1.minute.get')).toBe(true);
    expect(registry.has('task.v2.task.get')).toBe(true); // task kept (option B)
    expect(registry.has('im.v1.message.delete')).toBe(false); // mutating skipped
    expect(registry.has('calendar.v4.event.create')).toBe(false); // mutating skipped
    expect(registry.has('payroll.v1.payment.list')).toBe(false); // sensitive domain skipped
    expect(registry.has('directory.v1.employee.list')).toBe(false); // sensitive domain skipped (raw project)
    expect(registry.has('search.v2.dataSource.get')).toBe(false); // search removed from allow-list
  });

  it('skips legacy v1 task endpoints but keeps v2 (v1 needs historical scopes; v2 is the successor)', () => {
    // The `task` project vendors both v1 and v2. v1 Task APIs need separate
    // "historical" OAuth scopes we do not request, so registering them would only
    // advertise endpoints that always 403. v2 reads are covered by the task:* read
    // scopes requested in authManager (PR #267 follow-up).
    const registry = new FeishuToolRegistry();
    const defs: LarkGenToolDef[] = [
      def({ name: 'task.v2.task.get', project: 'task', httpMethod: 'GET' }), // ✓ v2 read
      def({ name: 'task.v2.tasklist.list', project: 'task', httpMethod: 'GET' }), // ✓ v2 read (task:tasklist:read)
      def({ name: 'task.v1.task.get', project: 'task', httpMethod: 'GET' }), // ✗ legacy v1
      def({ name: 'task.v1.taskComment.list', project: 'task', httpMethod: 'GET' }), // ✗ legacy v1
    ];
    const stats = registerGeneratedTools(registry, callOpenApi, fmt, { defs });
    expect(stats).toEqual({ registered: 2, skipped: 2 });
    expect(registry.has('task.v2.task.get')).toBe(true);
    expect(registry.has('task.v2.tasklist.list')).toBe(true);
    expect(registry.has('task.v1.task.get')).toBe(false); // legacy v1 skipped
    expect(registry.has('task.v1.taskComment.list')).toBe(false); // legacy v1 skipped
  });

  it('projectToCategory: folds synonym projects but keeps drive as its own category', () => {
    // Synonyms fold into the premium hand-written buckets…
    expect(projectToCategory('docs')).toBe('docx');
    expect(projectToCategory('base')).toBe('bitable');
    expect(projectToCategory('sheets')).toBe('sheet');
    expect(projectToCategory('directory')).toBe('contact');
    // …but drive (cloud files) is a distinct surface, NOT folded into docx, so
    // `list_tools({ category: "drive" })` actually surfaces its tools (PR #267 P2).
    expect(projectToCategory('drive')).toBe('drive');
    // Unknown projects pass through unchanged.
    expect(projectToCategory('vc')).toBe('vc');
  });

  it('honors the include predicate', () => {
    const registry = new FeishuToolRegistry();
    const defs: LarkGenToolDef[] = [
      def({ name: 'vc.v1.meeting.get', project: 'vc' }),
      def({ name: 'approval.v4.instance.get', project: 'approval' }),
    ];
    const stats = registerGeneratedTools(registry, callOpenApi, fmt, {
      defs,
      include: (d) => d.project === 'vc',
    });
    expect(stats).toEqual({ registered: 1, skipped: 1 });
    expect(registry.has('vc.v1.meeting.get')).toBe(true);
    expect(registry.has('approval.v4.instance.get')).toBe(false);
  });

  it('uses the def.schema as the tool inputShape (validates through call)', async () => {
    const registry = new FeishuToolRegistry();
    registerGeneratedTools(registry, callOpenApi, fmt, {
      defs: [
        def({
          name: 'vc.v1.meetingRecording.get',
          path: '/open-apis/vc/v1/meetings/:meeting_id/recording',
          schema: { path: z.object({ meeting_id: z.string() }) },
        }),
      ],
    });
    callOpenApi.mockClear();
    // Valid args → dispatches.
    await registry.call('vc.v1.meetingRecording.get', { path: { meeting_id: 'm9' } });
    expect(callOpenApi).toHaveBeenCalledWith(
      'GET',
      '/open-apis/vc/v1/meetings/m9/recording',
      expect.anything(),
    );
    // Invalid args (wrong type) → registry returns INVALID_ARGS before handler.
    const bad = await registry.call('vc.v1.meetingRecording.get', {
      path: { meeting_id: 123 },
    });
    expect(bad.isError).toBe(true);
  });

  it('strips upstream useUAT from the schema (dispatcher is user-token only)', async () => {
    // The dispatcher always uses the user-token path, so the tenant/user
    // selector `useUAT` must not be advertised — otherwise `useUAT:false`
    // (tenant) would be silently ignored. After stripping, a stray `useUAT`
    // fails strict validation with a clear INVALID_ARGS (PR #267 P2).
    const registry = new FeishuToolRegistry();
    registerGeneratedTools(registry, callOpenApi, fmt, {
      defs: [
        def({
          name: 'vc.v1.meeting.get',
          path: '/open-apis/vc/v1/meetings/:meeting_id',
          schema: {
            path: z.object({ meeting_id: z.string() }),
            useUAT: z.boolean().optional(),
          },
        }),
      ],
    });
    callOpenApi.mockClear();
    // Valid args (no useUAT) → dispatches.
    await registry.call('vc.v1.meeting.get', { path: { meeting_id: 'm1' } });
    expect(callOpenApi).toHaveBeenCalledWith(
      'GET',
      '/open-apis/vc/v1/meetings/m1',
      expect.anything(),
    );
    // useUAT was stripped → strict-object validation rejects it, no dispatch.
    callOpenApi.mockClear();
    const bad = await registry.call('vc.v1.meeting.get', {
      path: { meeting_id: 'm1' },
      useUAT: false,
    });
    expect(bad.isError).toBe(true);
    expect(callOpenApi).not.toHaveBeenCalled();
  });
});
