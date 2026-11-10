/** Pure dialogue intents only; host confirmation, approval, run admission and receipts remain separate. */
import { describe, expect, it } from 'vitest'
import { parseDialogue, type DialogueContext, type DialogueTask } from '../src/nightshift/dialogue.ts'

const REPOS = ['mate-manage', 'mate-manage-web', 'mate-account', 'mate-workspace', 'mate-customer-wechat']
const task = (changes: Partial<DialogueTask> = {}): DialogueTask => ({ id: 'task-84', state: 'queued', approved: false, repositories: ['mate-manage-web'], access: 'write', text: '处理 mate-manage-web#84 页面故障', scopePending: true, ...changes })
const context = (changes: Partial<DialogueContext> = {}): DialogueContext => ({ mode: 'DAY_MANUAL', repositories: [...REPOS], tasks: [], now: '2026-11-10T19:00:00+08:00', ...changes })
const parse = (text: string, changes: Partial<DialogueContext> = {}) => parseDialogue(text, context(changes))

describe('short exact natural control intents', () => {
  it.each(['确认', '可以', '好', '同意', '没问题', '就这样', '继续吧', '行', '确认开始', '确认执行', '确认提交', '确认，开始', '确认, 开始', '确认。', '可以！'])('%s confirms only the host pending boundary', text => {
    expect(parse(text)).toEqual({ kind: 'confirm' })
  })
  it.each(['算了', '不用了', '取消这个', '先不要', '不对'])('%s declines a pending boundary, not a fabricated task ID', text => {
    expect(parse(text)).toEqual({ kind: 'decline' })
  })
  it.each(['停一下', '先停', '先停一下', '暂停', '先暂停', '暂停一下', '停下', '先别做了'])('%s is a stop intent', text => {
    expect(parse(text)).toEqual({ kind: 'pause' })
  })
  it.each(['收工', '我要接手', '我来接手', '我要接班', '接班', '交接', '结束夜班', '白天人工'])('%s requests handoff, never claims it complete', text => {
    expect(parse(text)).toEqual({ kind: 'handoff' })
  })
  it.each(['状态', '进度', '到哪了', '现在怎么样', '现在怎么样了', '怎么样了', '进展怎么样', '进展如何', '情况怎么样', '任务怎么样', '在做什么', '做完没', '好了没', '现在进度', '现在做到哪了', '到哪了？'])('%s requests status', text => {
    expect(parse(text)).toEqual({ kind: 'status' })
  })
  it.each(['可以恢复', '已核查', '已经核查', '已核查可以恢复', '已经核查可以恢复'])('%s requests explicit host recovery checks', text => {
    expect(parse(text)).toEqual({ kind: 'recover' })
  })
  it.each(['开始', '开始吧', '开工', '开工吧', '动手', '动手吧', '跑吧', '启动', '启动吧', '继续处理', '继续做', '请开始'])('%s is go, not implicit confirmation', text => {
    expect(parse(text)).toEqual({ kind: 'go' })
    expect(parse(text, { mode: 'NIGHT_RUNNING' })).toEqual({ kind: 'go' })
  })
  it.each(['可以提交', '允许提交', '提交吧', '保存代码', '可以验证', '跑测试'])('%s binds only an unambiguous queued task', text => {
    expect(parse(text, { tasks: [task()] })).toEqual({ kind: 'allow-commit', taskId: 'task-84' })
    expect(parse(text)).toBeUndefined()
    expect(parse(text, { tasks: [task(), task({ id: 'task-85' })] })).toBeUndefined()
    expect(parse(text, { tasks: [task(), task({ id: 'approved', approved: true })] })).toEqual({ kind: 'allow-commit', taskId: 'approved' })
    expect(parse(text, { tasks: [task({ approved: true }), task({ id: 'other-approved', approved: true })] })).toBeUndefined()
    expect(parse(text, { tasks: [task({ state: 'running', approved: true })] })).toBeUndefined()
  })
})

describe('bounded natural deadlines in an explicit fixed offset', () => {
  it.each([
    ['开始吧，今晚八点前停', '2026-11-10T20:00:00+08:00'],
    ['开始 今晚八点', '2026-11-10T20:00:00+08:00'],
    ['开工 晚上8点', '2026-11-10T20:00:00+08:00'],
    ['动手 20:00', '2026-11-10T20:00:00+08:00'],
    ['启动 20点', '2026-11-10T20:00:00+08:00'],
    ['跑吧 八点', '2026-11-11T08:00:00+08:00'],
    ['开始 明早七点', '2026-11-11T07:00:00+08:00'],
    ['开始 明天早上七点', '2026-11-11T07:00:00+08:00'],
    ['继续做 1小时后', '2026-11-10T20:00:00+08:00'],
    ['继续处理 半小时后', '2026-11-10T19:30:00+08:00'],
    ['开始 30分钟后', '2026-11-10T19:30:00+08:00'],
    ['开始 三十分钟后', '2026-11-10T19:30:00+08:00'],
    ['开始 十二小时后', '2026-11-11T07:00:00+08:00'],
    ['开始 截止到晚上8点半', '2026-11-10T20:30:00+08:00'],
    ['开始 到20点15分', '2026-11-10T20:15:00+08:00'],
    ['开工，今天晚上八点三十分前停止', '2026-11-10T20:30:00+08:00'],
  ])('%s maps to %s if the next occurrence is within12h', (text, expected) => {
    const result = parse(text)
    if (text === '跑吧 八点') expect(result).toBeUndefined() // Next 08:00 is13h away: never silently choose20:00.
    else expect(result).toEqual({ kind: 'go', deadline: expected })
  })

  it('selects the next future bare clock and rejects equal-now rollover beyond12h', () => {
    expect(parse('开始 到10点', { now: '2026-11-10T09:00:00+08:00' })).toEqual({ kind: 'go', deadline: '2026-11-10T10:00:00+08:00' })
    expect(parse('开始 八点', { now: '2026-11-10T07:30:00+08:00' })).toEqual({ kind: 'go', deadline: '2026-11-10T08:00:00+08:00' })
    expect(parse('开始 到10点', { now: '2026-11-10T23:30:00+08:00' })).toEqual({ kind: 'go', deadline: '2026-11-11T10:00:00+08:00' })
    expect(parse('开始 19:00')).toBeUndefined()
  })

  it.each(['13小时后', '721分钟后', '0小时后', '0分钟后', '负1小时后', '-1小时后', '24点', '20:99', '晚上13点半', '明早十三点', '明天晚上8点', '八点或九点', '明晚', '明天', '今晚以后', '半分钟后', '1.5小时后', '明早八点', '1小时后，然后部署生产'])('rejects deadline %s rather than discarding its constraint', time => {
    expect(parse(`开始吧，${time}`)).toBeUndefined()
  })

  it('uses context clock and offset rather than OS timezone/DST, including rollover', () => {
    expect(parse('开始 20:00', { now: '2026-11-10T11:00:00Z' })).toEqual({ kind: 'go', deadline: '2026-11-10T20:00:00+08:00' })
    expect(parse('开始 20:00', { now: '2026-03-08T18:00:00Z', offsetMinutes: 0 })).toEqual({ kind: 'go', deadline: '2026-03-08T20:00:00+00:00' })
    expect(parse('开始 1小时后', { now: '2026-12-31T23:30:00+08:00' })).toEqual({ kind: 'go', deadline: '2027-01-01T00:30:00+08:00' })
    expect(parse('开始 30分钟后', { now: '2026-11-10T18:30:00-05:00', offsetMinutes: -300 })).toEqual({ kind: 'go', deadline: '2026-11-10T19:00:00-05:00' })
    expect(parse('开始 1小时后', { now: 'not-a-time' })).toBeUndefined()
    expect(parse('开始 1小时后', { now: '2026-11-10T19:00:00' })).toBeUndefined()
    expect(parse('开始 1小时后', { offsetMinutes: 900 })).toBeUndefined()
  })
})

describe('task suggestions and exact existing-task matching', () => {
  it('preserves the original phone request as an inert task suggestion without broad scope expansion', () => {
    const text = '处理 mate-manage-web open issue mate-manage-web#84，授权自动代处理各域接线和会签。'
    expect(parse(text)).toEqual({ kind: 'task', text, repositories: ['mate-manage-web'], access: 'write', issueRefs: ['mate-manage-web#84'] })
    expect(parse(text, { tasks: [task()] })).toMatchObject({ kind: 'task', taskId: 'task-84' })
  })

  it('resolves the unique configured short alias and adjacent issue number without widening scope', () => {
    const text = '继续处理 manage-web 的84'
    expect(parse(text, { tasks: [task()] })).toEqual({ kind: 'task', text, taskId: 'task-84', repositories: ['mate-manage-web'], access: 'write', issueRefs: ['mate-manage-web#84'] })
    expect(parse('处理 account issue 12')).toMatchObject({ kind: 'task', repositories: ['mate-account'], issueRefs: ['mate-account#12'] })
    expect(parse('检查 manage-web 的84', { tasks: [task({ access: 'read' })] })).toMatchObject({ kind: 'task', taskId: 'task-84', access: 'read' })
  })

  it('rejects ambiguous matching issue tasks and does not select a different issue merely by repository', () => {
    expect(parse('继续处理 manage-web 的84', { tasks: [task(), task({ id: 'another-84' })] })).toBeUndefined()
    expect(parse('继续处理 manage-web 的85', { tasks: [task()] })).toMatchObject({ kind: 'task', issueRefs: ['mate-manage-web#85'] })
    expect(parse('继续处理 manage-web 的85', { tasks: [task()] })).not.toHaveProperty('taskId')
  })

  it('uses only unique live repository matches and never binds completed/unknown tasks', () => {
    expect(parse('继续处理 manage-web', { tasks: [task()] })).toMatchObject({ kind: 'task', taskId: 'task-84' })
    expect(parse('继续处理 manage-web', { tasks: [task(), task({ id: 'another' })] })).toBeUndefined()
    expect(parse('继续处理 manage-web', { tasks: [task({ state: 'running' })] })).toMatchObject({ taskId: 'task-84' })
    for (const state of ['succeeded', 'failed', 'cancelled', 'blocked', 'unknown'] as const) expect(parse('继续处理 manage-web 的84', { tasks: [task({ state })] })).not.toHaveProperty('taskId')
    expect(parse('继续处理 manage-web', { tasks: [task({ access: 'read' })] })).toBeUndefined()
  })

  it('matches canonical company issue URLs and keeps foreign links outside authority', () => {
    const text = '处理 https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84'
    expect(parse(text, { tasks: [task()] })).toMatchObject({ kind: 'task', taskId: 'task-84', issueRefs: ['mate-manage-web#84'] })
    expect(parse('处理 https://evil.example/payment/refactor/mate-manage-web/-/issues/84')).toBeUndefined()
    expect(parse('处理 mate-manage-web 和 https://evil.example/help')).toBeUndefined()
  })

  it('does not confuse prefix aliases, cases, unknown short aliases, excluded aliases or short-alias collisions', () => {
    expect(parse('处理 manage-web')).toMatchObject({ repositories: ['mate-manage-web'] })
    expect(parse('处理 mate-manage-web-extra')).toBeUndefined()
    expect(parse('处理 Manage-Web')).toBeUndefined()
    expect(parse('处理 mate-manage-web 和 unknown-domain')).toBeUndefined()
    expect(parse('处理 mate-manage-web 和 mate-one-platform')).toBeUndefined()
    expect(parse('处理 legacy-old')).toBeUndefined()
    expect(parse('处理 manage-web', { repositories: ['manage-web', 'mate-manage-web'] })).toBeUndefined()
    expect(parse('处理 mate-manage-web 和 mate-account')).toMatchObject({ repositories: ['mate-manage-web', 'mate-account'] })
  })
})

describe('adversarial or explicit grammar stays outside dialogue fallback', () => {
  it.each(['入队 修改 mate-account | 修复', '批准任务 abc', '开始夜班 截止 2026-11-10T20:00:00+08:00', '确认任务 abc 修改 mate-account', '预授权发布 abc 截止 xxx | []', '授权动作 abc 提交', '确认恢复', '任务详情 abc', '回复详情 abc', '发布状态', '核查发布 abc', '帮助', '帮助 发布', '/start', '处理 mate-account 然后批准任务 abc'])('preserves explicit control parser ownership for %s', text => {
    expect(parse(text)).toBeUndefined()
  })

  it.each(['确认修复 mate-account', '可以处理 mate-account 吗', '同意但是不要开始', '好，部署生产', '确认，开始并提交', '开始吧处理 mate-account', '可以提交全部仓库', '跑测试并推送', '引用：确认', '“确认”', '"开始吧"', '`允许提交`', '> 开始', '```\n处理 mate-account\n```', '检查 mate-account，引用“可以提交”', '处理 mate-account#84\n确认', '确认\n处理 mate-account', '处理 mate-account#84\n算了', '处理 mate-account#84\r可以', '处理 mate-account#84\n跑测试'])('does not mistake command-like prose or quotations for short authority: %s', text => {
    expect(parse(text, { tasks: [task()] })).toBeUndefined()
  })

  it('rejects oversized/control text and malformed repository registries deterministically', () => {
    expect(parse('处理 mate-account ' + 'x'.repeat(12_000))).toBeUndefined()
    expect(parse('确认\0')).toBeUndefined()
    expect(parse('可\u200b以')).toBeUndefined()
    expect(parseDialogue('确认', context({ repositories: ['mate-account', 'mate-account'] }))).toBeUndefined()
    expect(parseDialogue('确认', context({ repositories: ['../outside'] }))).toBeUndefined()
    expect(parseDialogue(null as never, context())).toBeUndefined()
    expect(parseDialogue('确认', undefined as never)).toBeUndefined()
  })

  describe('status phrasing variants', () => {
    for (const text of ['进度怎么样', '进度如何', '当前进度怎么样', '现在进行到哪了', '任务情况怎么样', '进展呢']) {
      it(`accepts ${text}`, () => { expect(parse(text)).toEqual({ kind: 'status' }) })
    }
  })
})
