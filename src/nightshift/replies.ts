/** Bounded private replies; full receipts stay in the caller's durable store.
 * This formatter is not a secret sanitizer or authorization source. Detail pages
 * must receive only caller-authorized/redacted content and are never auto-sent.
 */
import { checkedImText, IM_WORDS, wordCount } from '../infra/text.ts'

const MAX_REPLY_CHARS = 2000
const PAGE_BODY_WORDS = 60
const PAGE_BODY_CHARS = 1000
const PAGE_WORDS = 80
const MAX_INPUT_CHARS = 1_000_000
const MAX_PAGES = 10_000
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' })
const wordSegments = new Intl.Segmenter('zh', { granularity: 'word' })
const FALLBACK = '摘要（非完整回执）\n回复内容较长，未在此完整显示。请用任务详情或回复详情命令核对；不要据此判断批准、完成或接班。'
const PAGE_WARNING = '分页摘录，不是新的批准或接班确认；须核对完整回执。'

function detailCommand(hint?: string): string | undefined {
  if (typeof hint !== 'string' || hint.length > 200 || hint.includes('://')) return undefined
  // Caller-controlled retrieval command only. Free prose, URLs and injection-like
  // delimiters are not copied into an overlimit fallback.
  return /^(?:回复详情|任务详情) [A-Za-z0-9_:.-]{1,180}(?: [1-9][0-9]{0,5})?$/u.test(hint) ? hint : undefined
}

/** Return one <=100-word message. Overlimit text is NOT excerpted: preserving
 * an opening “已批准/可接班” while dropping its negation would invent authority.
 * Short valid messages remain byte-for-byte unchanged, including whitespace.
 */
export function boundedNightReply(text: string, detailHint?: string): string {
  if (text.length <= MAX_REPLY_CHARS && wordCount(text) <= IM_WORDS) return checkedImText(text)
  const hint = detailCommand(detailHint)
  const fallback = hint ? `${FALLBACK}\n查看：${hint}` : FALLBACK
  // A maximal identifier can itself segment into many words. Never throw or
  // split deliveries just because a caller supplied a pathological detail ID.
  return checkedImText(wordCount(fallback) <= IM_WORDS ? fallback : FALLBACK)
}

interface Slice { start: number; end: number }
function slices(text: string): Slice[] | undefined {
  if (!text.length) return [{ start: 0, end: 0 }]
  const pages: Slice[] = []
  let start = 0
  let end = 0
  let count = 0
  const push = () => {
    if (end > start) { pages.push({ start, end }); start = end; count = 0 }
    return pages.length < MAX_PAGES
  }
  for (const segment of wordSegments.segment(text)) {
    if (segment.segment.length <= PAGE_BODY_CHARS) {
      const words = segment.isWordLike ? 1 : 0
      if (end > start && (segment.index + segment.segment.length - start > PAGE_BODY_CHARS || count + words > PAGE_BODY_WORDS)) {
        if (!push()) return undefined
      }
      end = segment.index + segment.segment.length; count += words
      continue
    }
    if (end > start && !push()) return undefined
    // A huge URL, identifier or punctuation run may count as almost no words.
    // Split on grapheme boundaries, never within surrogate pairs/emoji clusters.
    for (const piece of graphemes.segment(segment.segment)) {
      if (piece.segment.length > PAGE_BODY_CHARS) return undefined
      const at = segment.index + piece.index
      if (end > start && at + piece.segment.length - start > PAGE_BODY_CHARS) {
        if (!push()) return undefined
      }
      end = at + piece.segment.length
      // Every slice of an oversized word is still at most one word; this branch
      // never mixes that word with another without normal boundary accounting.
      count = Math.max(count, segment.isWordLike ? 1 : 0)
    }
  }
  if (end > start) pages.push({ start, end })
  return pages.length <= MAX_PAGES ? pages : undefined
}

/** Explicit one-based retrieval, never automatic multi-message delivery. Returns
 * <=80 words including the non-authority envelope; body budget is 60 words.
 * Reject impossible pages/oversized receipts rather than silently omitting text.
 */
export function replyPage(text: string, page: number): { text: string; totalPages: number } {
  if (text.length > MAX_INPUT_CHARS) return { text: checkedImText('回执超过分页处理上限，未显示任何摘录。请使用受控详情入口核对；不能据此判断完成或接班。'), totalPages: 0 }
  const pages = slices(text)
  if (!pages) return { text: checkedImText('回执含超长文本单元或页数超过上限，未截断显示。请使用受控详情入口核对；不能据此判断完成或接班。'), totalPages: 0 }
  if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) return { text: checkedImText(`页码无效。共有 ${pages.length} 页，请指定范围内的正整数页码；此回复不表示批准、完成或接班。`), totalPages: pages.length }
  const selected = pages[page - 1]!
  const body = text.slice(selected.start, selected.end)
  const rendered = `详情 ${page}/${pages.length}\n${PAGE_WARNING}\n\n${body || '（空回执）'}`
  if (wordCount(rendered) > PAGE_WORDS || rendered.length > MAX_REPLY_CHARS) {
    // Defensive fail-closed check if ICU segmentation changes in a future runtime.
    return { text: checkedImText('本页无法安全显示，未截断回执。请使用受控详情入口核对；不能据此判断完成或接班。'), totalPages: pages.length }
  }
  return { text: checkedImText(rendered), totalPages: pages.length }
}
