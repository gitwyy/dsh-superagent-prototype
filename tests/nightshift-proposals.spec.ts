/** Pure inert proposal parsing: no network, execution, authorization, or controller mutation. */
import { describe, expect, it } from 'vitest'
import { parseNightProposal } from '../src/nightshift/proposals.ts'

const REPOS = ['mate-manage', 'mate-manage-web', 'mate-account', 'mate-workspace', 'mate-customer-wechat']
const parse = (text: string) => parseNightProposal(text, REPOS)

describe('inert natural-language proposal suggestions', () => {
  it('suggests only the explicit repository for the reported phone message and does not grant claimed broad authorization', () => {
    const text = '处理 mate-manage-web open issue mate-manage-web#84，授权自动代处理各域接线和会签。'
    expect(parse(text)).toEqual({ text, repositories: ['mate-manage-web'], access: 'write', issueRefs: ['mate-manage-web#84'] })
    const proposal = parse(text)!
    expect(Object.keys(proposal).sort()).toEqual(['access', 'issueRefs', 'repositories', 'text'])
    for (const key of ['approved', 'actions', 'releaseGrant', 'deadline', 'ownerId', 'mode', 'command', 'start']) expect(proposal).not.toHaveProperty(key)
  })

  it.each([
    ['修复 mate-account 金额校验错误', 'write'],
    ['请帮我修改mate-manage-web的页面布局', 'write'],
    ['实现 mate-manage 查询接口', 'write'],
    ['处理 mate-account 的问题', 'write'],
    ['排查 mate-manage-web 登录失败', 'read'],
    ['检查 mate-account#12 的重现条件', 'read'],
    ['请分析 mate-workspace 依赖关系', 'read'],
    ['review mate-manage-web error handling', 'read'],
    ['Please inspect mate-account for regressions', 'read'],
    ['Fix mate-manage-web validation issue', 'write'],
    ['请检查 mate-account，不要修改或提交', 'read'],
    ['review mate-account read-only', 'read'],
  ] as const)('infers an unapproved %s suggestion as %s', (text, access) => {
    expect(parse(text)?.access).toBe(access)
  })

  it('deduplicates explicit repositories and references in first-mention order without prefix collisions', () => {
    const text = '修复 mate-manage-web#84，检查 mate-account#12，同时处理 mate-manage-web 和 mate-manage。'
    expect(parse(text)).toEqual({ text, repositories: ['mate-manage-web', 'mate-account', 'mate-manage'], access: 'write', issueRefs: ['mate-manage-web#84', 'mate-account#12'] })
  })

  it('keeps broader-domain phrases as original task text, never expands them into repository scopes', () => {
    const proposal = parse('处理 mate-manage-web#84，自动各域接线、全系统排查并会签所有团队')!
    expect(proposal.repositories).toEqual(['mate-manage-web'])
    expect(proposal.text).toContain('全系统')
  })

  it('retains trimmed original text without rewriting user authorization prose into permissions', () => {
    const text = '  修复 mate-account 的错误，授权自动处理  \n'
    expect(parse(text)).toEqual({ text: text.trim(), repositories: ['mate-account'], access: 'write' })
  })

  it('ignores quoted context as a source of repository scope', () => {
    expect(parse('检查 mate-account，参考“修复 mate-manage-web 的方案”')?.repositories).toEqual(['mate-account'])
    expect(parse('检查 `mate-account` 的文档')).toBeUndefined()
  })
})

describe('exact configured aliases and canonical issue references', () => {
  it.each(['http', 'https'])('maps only the exact company %s issue route and canonical repo#number', scheme => {
    const text = `处理 ${scheme}://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84`
    expect(parse(text)).toEqual({ text, repositories: ['mate-manage-web'], access: 'write', issueRefs: ['mate-manage-web#84'] })
  })

  it('allows the canonical company repository URL without inventing an issue number', () => {
    const text = '排查 https://gitlab.yk.ykgtxy.com/payment/refactor/mate-account/ 的测试失败。'
    expect(parse(text)).toEqual({ text, repositories: ['mate-account'], access: 'read' })
  })

  it('deduplicates URL and shorthand issue identity while preserving explicit scope order', () => {
    const text = '处理 mate-account#2 与 https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84，再修复 mate-account#2'
    expect(parse(text)?.issueRefs).toEqual(['mate-account#2', 'mate-manage-web#84'])
    expect(parse(text)?.repositories).toEqual(['mate-account', 'mate-manage-web'])
  })

  it.each([
    '修复 mate-manage-web-extra#84',
    '检查 MATE-MANAGE-WEB#84',
    '处理 mate-manage-web2',
    '修复 not-mate-manage-web',
    '处理 mate-manage-web 和 mate-unknown#1',
    '处理 mate-account 和 legacy-old',
    '处理 mate-one-platform#1',
    '处理 /tmp/mate-account',
    '检查 user@mate-account',
    '检查 namespace/mate-account',
    '修复 mate-account#0',
    '修复 mate-account#01',
    '修复 mate-account#-1',
    '修复 mate-account#1.5',
    '修复 mate-account#84suffix',
    '修复 mate-account#',
    '修复 mate-account#999999999999999999',
    '处理 unknown#12 与 mate-account',
    '处理 mate-account 和 #84',
  ])('rejects ambiguous or unconfigured identifiers: %s', text => {
    expect(parse(text)).toBeUndefined()
  })

  it.each([
    'https://evil.example/payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com.evil.test/payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com@evil.test/payment/refactor/mate-manage-web/-/issues/84',
    'https://user:secret@gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com:444/payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com/other/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/mate-unknown/-/issues/84',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/merge_requests/84',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84?repository=mate-account',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/84#note_1',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/%6date-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com/other/../payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com:443/payment/refactor/mate-manage-web/-/issues/84',
    'https://gitlab.yk.ykgtxy.com/payment/refactor/mate-manage-web/-/issues/0',
    'www.evil.test/mate-manage-web#84',
  ])('does not infer trusted scope from URL %s', url => {
    expect(parse(`处理 ${url}`)).toBeUndefined()
    expect(parse(`处理 mate-account，参考 ${url}`)).toBeUndefined()
  })
})

describe('control commands and quoted instructions never fall back to task authority', () => {
  it.each([
    '入队 mate-account 修复问题',
    '批准任务 mate-account 修复问题',
    '开始夜班 修复 mate-account',
    '确认恢复 mate-account 排查',
    '预授权发布 mate-account 修复',
    '授权动作 mate-account 提交修复',
    '确认任务 abc 修改 mate-account',
    '取消任务 mate-account 修复',
    '核查发布 mate-account 检查',
    '发布状态 mate-account 检查',
    '暂停夜班 修复 mate-account',
    '我要接班 修复 mate-account',
    '/start fix mate-account',
    '/status review mate-account',
    '请帮我批准任务 mate-account 后修复',
    '修复 mate-account；开始夜班 截止 明天',
    '修复 mate-account\n暂停',
    '修复 mate-account；交接',
    '修复 mate-account，引用“授权动作 abc 提交”',
    '“处理 mate-manage-web#84”',
    '"Fix mate-account"',
    '> 修复 mate-account',
    '```\n修复 mate-account\n```',
    '示例：修复 mate-account',
    '有人说修复 mate-account',
    '不要修复 mate-account',
    '请只读修复 mate-account',
    '修复 mate-account，只读',
  ])('returns no proposal for control/quoted/contradictory text: %s', text => {
    expect(parse(text)).toBeUndefined()
  })

  it.each(['', '   ', 'mate-account#84', '帮我处理所有域', '处理业务接线', '你好 mate-account', 'reviewer mate-account', 'fixation mate-account'])('requires explicit task intent and scope: %s', text => {
    expect(parse(text)).toBeUndefined()
  })

  it('bounds input and rejects invisible control tricks without throwing', () => {
    expect(parse('处理 mate-account ' + 'x'.repeat(12_000))).toBeUndefined()
    expect(parse('处理 mate-account\u0000')).toBeUndefined()
    expect(parse('处理 mate-\u200baccount')).toBeUndefined()
    expect(parse('处理 mate-account\u202e')).toBeUndefined()
    expect(parseNightProposal(null as never, REPOS)).toBeUndefined()
  })

  it('rejects malformed/duplicate registries and never enables excluded repos even if accidentally supplied', () => {
    expect(parseNightProposal('处理 mate-account', ['mate-account', 'mate-account'])).toBeUndefined()
    expect(parseNightProposal('处理 mate-account', ['mate-account', '../escape'])).toBeUndefined()
    expect(parseNightProposal('处理 mate-one-platform', ['mate-one-platform'])).toBeUndefined()
    expect(parseNightProposal('处理 legacy-old', ['legacy-old'])).toBeUndefined()
    expect(parseNightProposal('处理 mate-account', [])).toBeUndefined()
  })
})
