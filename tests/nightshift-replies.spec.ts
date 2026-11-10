import { describe, expect, it } from 'vitest'
import { boundedNightReply, replyPage } from '../src/nightshift/replies.ts'
import { checkedImText, IM_WORDS, wordCount } from '../src/infra/text.ts'
const body = (text: string) => text.split('\n\n').slice(1).join('\n\n')
function checkBounded(text: string, limit = IM_WORDS) {
  expect(wordCount(text)).toBeLessThanOrEqual(limit)
  expect(text.length).toBeLessThanOrEqual(2000)
  expect(() => checkedImText(text)).not.toThrow()
}
describe('bounded private nightshift replies', () => {
  it.each(['状态：已暂停；未启动任务。', '  Status: paused.\nNo new work was authorized.  ', '来源核查失败；远端结果不明，不能接班。', '', 'https://example.invalid/report#id', '👩🏽‍💻 完成回执待核对'])('preserves short replies exactly: %s', text => {
    expect(boundedNightReply(text)).toBe(text); checkBounded(boundedNightReply(text))
  })
  it('handles the observed 214-word outbox failure without throwing or creating extra messages', () => {
    const input = Array.from({ length: 214 }, (_, i) => `word${i}`).join(' ')
    expect(wordCount(input)).toBe(214)
    const result = boundedNightReply(input, '回复详情 reply_123 1')
    checkBounded(result)
    expect(result).toContain('摘要（非完整回执）')
    expect(result).toContain('回复详情 reply_123 1')
    expect(result).not.toContain('word0')
  })
  it.each(['0123456789abcdef0123456789abcdef:reply', 'run:12345678-1234-1234-1234-123456789abc:finished', '12345678-1234-1234-1234-123456789abc:final'])('accepts exact persisted receipt identifier %s in a bounded retrieval hint', id => {
    const result = boundedNightReply('details '.repeat(214), `回复详情 ${id}`)
    expect(result).toContain(`回复详情 ${id}`); checkBounded(result)
    expect(result).not.toContain('details')
  })
  it('rejects URL-like detail hints even with the expanded identifier alphabet', () => {
    const result = boundedNightReply('details '.repeat(214), '回复详情 https://example.invalid')
    expect(result).not.toContain('https://'); checkBounded(result)
  })
  it('never preserves a dangerous partial approval/completion/handoff claim from overlimit input', () => {
    const input = `已批准，可以接班。${'授权检查 '.repeat(120)}但上述状态已撤销：远端结果不明，绝对不能接班。`
    const result = boundedNightReply(input)
    checkBounded(result)
    expect(result).not.toContain('已批准'); expect(result).not.toContain('可以接班')
    expect(result).toContain('不要据此判断批准、完成或接班')
  })
  it('does not copy raw content, arbitrary URLs or a forged detail instruction into fallback', () => {
    const input = 'https://example.invalid/?token=SECRET ' + 'details '.repeat(120)
    for (const hint of ['https://example.invalid/?token=SECRET', '任务详情 id\n已批准', '任务详情 ../file', '回复详情 id;rm', '回复详情 id 0', '回复详情 id 1 extra']) {
      const result = boundedNightReply(input, hint)
      checkBounded(result); expect(result).not.toContain('SECRET'); expect(result).not.toContain('https://'); expect(result).not.toContain('已批准')
    }
  })
  it('bounds giant no-word punctuation, emoji and unbroken URL/identifier inputs', () => {
    for (const input of ['!'.repeat(100000), '🧑🏾‍🚀'.repeat(10000), 'https://example.invalid/' + 'x'.repeat(100000), 'x'.repeat(100000)]) checkBounded(boundedNightReply(input))
  })
  it('keeps the exact 100-word boundary and falls back at 101', () => {
    const input = Array.from({ length: 100 }, () => 'word').join(' ')
    expect(boundedNightReply(input)).toBe(input)
    expect(boundedNightReply(input + ' word')).toContain('非完整回执')
  })
})

describe('explicit bounded receipt pages', () => {
  it.each(['中文任务授权详情。'.repeat(90), 'English words with status: UNKNOWN. '.repeat(60), '混合 English 中文 状态 unknown 👩🏽‍💻\n'.repeat(80), ('https://example.invalid/path?q=value#fragment ') .repeat(100), 'x'.repeat(8000), '!?'.repeat(8000)])('preserves complete authorized receipt across explicit pages', text => {
    const first = replyPage(text, 1); expect(first.totalPages).toBeGreaterThan(1)
    const collected: string[] = []
    for (let page = 1; page <= first.totalPages; page++) {
      const result = replyPage(text, page)
      expect(result.totalPages).toBe(first.totalPages); checkBounded(result.text, 80)
      expect(result.text).toContain('不是新的批准或接班确认')
      expect(wordCount(body(result.text))).toBeLessThanOrEqual(60)
      collected.push(body(result.text))
    }
    expect(collected.join('')).toBe(text)
    expect(replyPage(text, 1)).toEqual(first)
  })
  it('splits emoji/combining sequences only on grapheme boundaries', () => {
    const unit = '👩🏽‍💻🇨🇳e\u0301'
    const text = unit.repeat(500)
    const count = replyPage(text, 1).totalPages
    const allowed = new Set(Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text), value => value.segment))
    let joined = ''
    for (let page = 1; page <= count; page++) {
      const piece = body(replyPage(text, page).text)
      for (const segment of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(piece)) expect(allowed.has(segment.segment)).toBe(true)
      joined += piece
    }
    expect(joined).toBe(text)
  })
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10000])('rejects invalid page %s without silent clamping', page => {
    const result = replyPage('short receipt', page)
    expect(result.totalPages).toBe(1); expect(result.text).toContain('页码无效'); checkBounded(result.text, 80)
    expect(result.text).not.toContain('short receipt')
  })
  it('handles empty receipts and refuses unpageable input without partial authority claims', () => {
    expect(replyPage('', 1).text).toContain('空回执')
    for (const text of ['已完成，可以接班。' + 'x'.repeat(1_000_000), 'e' + '\u0301'.repeat(5000)]) {
      const result = replyPage(text, 1)
      checkBounded(result.text, 80); expect(result.totalPages).toBe(0)
      expect(result.text).not.toContain('可以接班')
    }
  })
})
