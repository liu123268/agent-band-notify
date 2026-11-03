'use strict';
/**
 * Text-level judgement about a finished turn's final message.
 *
 * Two questions matter, and both are answered from the text because Codex's
 * rollout carries no other signal (and WorkBuddy's carries no such signal at all):
 *
 *   1. Is the assistant handing the turn BACK to the user because it is BLOCKED —
 *      a question, a choice, a request to do something on their side?
 *   2. Is it saying "I am still going" (an intermediate step inside a bigger job)?
 *
 * (1) must be announced loudly: the user is blocked until they answer.
 * (2) must NOT be announced as "已完成", because it is exactly what makes a
 * completion notification look wrong — the task is only part-done.
 *
 * ── Why "it ends with a question" is NOT the test (2026-10-05) ────────────────
 * The first version treated any trailing question mark as "it is waiting for you".
 * That is wrong for a normal chat assistant, and the live case proved it: a
 * 2106-character delivery (a full report, with a diff, tests and a design note)
 * whose LAST sentence happened to be "你觉得该不该现在统一…？" was reported as
 * `❓ 等你回答` — the user got a "waiting for you" alert for a turn that had in fact
 * delivered everything and finished. That is worse than useless: it trains you to
 * ignore the one state that is supposed to mean "I am stuck, come help".
 *
 * The judgement is now about INTENT, with two independent signals:
 *
 *   a) **Explicitly asking the user FOR something** (告诉我…/请你…/截图给我…) —
 *      a handover no matter how long the message is.
 *   b) **Everything else that hands control back** — a decision question,
 *      "要不要…", "吗/呢". Counts normally, EXCEPT when the closing question is
 *      explicitly framed as optional reflection (OPTIONAL), which is the shape the
 *      production false positive had.
 *
 * ── The wrong lever, kept here as a warning (2026-10-05, same day) ─────────────
 * The first attempt at (b) gated it by message LENGTH. Measuring against the real
 * corpus killed that idea: the false positive was 2106 chars, and the genuine
 * blockers it was dropping ran 517…17331 — the same range, so length separated
 * nothing. It silently relabelled 54 replies as "已完成", and most of those really
 * were the AI blocked on the user:
 *
 *   len=4145  "…在你明确选择前，我不会关联或推送。"
 *   len=2156  "要不要现在装？还是要继续测其他功能？"
 *   len= 580  "现在要 push 吗？要的话我回 "push" 就帮你推上去。"
 *
 * A genuine blocker shown as ✅ means the user may never reply, which costs more
 * than the occasional over-eager ❓. So: default OFF, opt in with
 * BAND_NOTIFY_ASK_MAX_CHARS, and read tools/check-turn-text.js before changing it.
 */

/** Trailing text worth inspecting: questions live at the end of the message. */
const TAIL_CHARS = 200;
/** A real handover puts its question mark right at the end, not mid-explanation. */
const END_CHARS = 30;

/**
 * How long a reply can be and still count as "it stopped to ask you something".
 *
 * ── Why this now defaults to 0 (OFF) ─────────────────────────────────────────
 * The first fix for the false `❓ 等你回答` gated the trailing-question signal by
 * length (400 chars). Measured against the real corpus, that was the wrong lever:
 *
 *   old rule flagged 262 / 950 main-thread replies
 *   length gate flagged 208  → it silently relabelled 54 as "已完成"
 *   the 54 span 517 … 17331 chars, and the false positive that motivated the whole
 *   thing was 2106 — i.e. squarely INSIDE that range
 *
 * Length therefore does not separate "delivered + asked by the way" from "delivered
 * + is now blocked on you", and most of the 54 were genuine blockers
 * ("在你明确选择前，我不会关联或推送", "要不要现在装？", "现在要 push 吗？").
 * Dropping those costs more than the annoyance it removes: a genuine blocker shown
 * as ✅ 已完成 means the user may never reply.
 *
 * So the mechanism is kept (set BAND_NOTIFY_ASK_MAX_CHARS to a positive number to
 * re-enable it) but the default is OFF, and the false positive is handled by
 * OPTIONAL below, which names the actual semantic class instead of a proxy.
 */
const DEFAULT_ASK_MAX_CHARS = (() => {
  const raw = Number(process.env.BAND_NOTIFY_ASK_MAX_CHARS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
})();

/**
 * Wording that frames the trailing question as OPTIONAL REFLECTION rather than a
 * blocker — the AI delivered everything, and this is a "by the way" musing.
 *
 * This is the surgical replacement for the length gate. It targets the exact string
 * that produced the production false positive:
 *   "最后一个值得你想一下的问题：…你觉得该不该现在统一，还是先让它稳着…？"
 * while leaving genuine blockers alone — they are phrased as direct questions and
 * never carry these softeners ("要不要现在装？", "现在要 push 吗？", "等你确认").
 *
 * Only consulted when the message does NOT explicitly ask the user for something,
 * so "如果你愿意的话，把日志发我" is still a handover.
 */
const OPTIONAL = /值得你(想|考虑)|值得考虑|可以考虑|如果你(愿意|有兴趣|觉得)|仅供参考|看你自己|不急|先不急着|都可以|看着办/;

/**
 * Explicit "I am continuing" markers. Deliberately narrow: only first-person
 * statements of intent to keep working, and only the unambiguous ones.
 *
 * 「我接着…」/「接下来我…」 are NOT included on purpose: in the real corpus they
 * usually announce the next *lesson* ("我接着教你 GUI 部署"), so treating them as
 * "still working" silently swallowed genuine questions. That bug was caught by
 * tools/test.js — do not widen this pattern without re-running it.
 */
const CONTINUING = /(我先|我再去|我继续把|正在(处理|执行|修改|检查)|继续处理中|马上就好|稍等)/;

/** Asking the user to act, in the many shapes Chinese assistants use. */
const ASKING = /[?？]|吗[。！!]?$|呢[。！!]?$|请你|麻烦你|(?<!不)需要你|等你|你(?:可以|想|要|希望|选|决定|来|试试|确认|回答|判断|看看|看一下)|先(?:检查|判断|看|确认|回答)|要不要|还是说|哪个(?:更|好)|哪种/;

/**
 * Imperatives whose whole point is to make the user hand something over:
 * information, a decision, or a screenshot. These are handovers even when the
 * sentence carries no question mark — "告诉我服务器类型（Ubuntu/CentOS/Debian？）".
 *
 * `发我` needs the guard: "引发我们的讨论" is not a request, and without the
 * lookbehind it read as one.
 */
const ASKS_FOR_SOMETHING = /(告诉|回复|回答|发给|截图|粘贴|贴给)我|(?<![引散触爆愈越开频分])发我|请(你|您)/;

/** True when the message explicitly asks the user for something (signal a). */
function asksForSomething(text) {
  return ASKS_FOR_SOMETHING.test(tail(text, TAIL_CHARS));
}

function tail(text, n = TAIL_CHARS) {
  return String(text || '').trim().slice(-n);
}

/**
 * True when the message ends by handing control back to the user *because it is
 * blocked*, rather than merely signing off.
 *
 * @param {string} text the turn's final assistant message
 * @param {{maxChars?: number}} [options] maxChars <= 0 disables the length gate
 *        (i.e. restores "any trailing question counts"); omitted → DEFAULT_ASK_MAX_CHARS
 */
function looksLikeQuestion(text, options) {
  const opts = options || {};
  const full = String(text || '').trim();
  const t = tail(full);
  if (!t) return false;

  // An explicit "still working" statement wins: it means the turn ended to report
  // progress, not to ask something. A real question mark still overrides it.
  if (CONTINUING.test(t) && !/[?？]\s*$/.test(t)) return false;

  // (a) It is asking the user for something. Length is irrelevant — "告诉我你的
  // 服务器类型" is a blocker even at the end of a long explanation. This also
  // outranks the OPTIONAL escape: "如果你愿意的话，把日志发我" is still a handover.
  if (asksForSomething(full)) return true;

  // (b) The closing question is explicitly framed as optional reflection
  // ("值得你想一下"), so it is a sign-off, not a block. See OPTIONAL above for why
  // this replaced the old length gate — the corpus said length was the wrong lever.
  if (OPTIONAL.test(t)) return false;

  // (c) Everything else that hands control back only counts for a SHORT message.
  // DEFAULT_ASK_MAX_CHARS is 0 by default, i.e. this gate is OFF — see above.
  const maxChars =
    opts.maxChars === undefined ? DEFAULT_ASK_MAX_CHARS : Number(opts.maxChars);
  if (Number.isFinite(maxChars) && maxChars > 0 && full.length > maxChars) return false;

  // A question mark must be *terminal*. "面试问“什么是结果映射”，你可以回答：…" is an
  // explanation that happens to quote a question, not a handover.
  if (/[?？]\s*$/.test(t)) return true;
  const lastTwoSentences = t.slice(-90);
  if (/[?？]/.test(lastTwoSentences)) return true;
  if (ASKS_FOR_SOMETHING.test(lastTwoSentences)) return true;
  // Anything else must be an explicit invitation, inside the closing sentence.
  //
  // ── Why `需要你` may NOT match bare (2026-10-06) ─────────────────────────────
  // Real alert, 00:41, Codex, "实时 Token 统计":
  //
  //   "已经好了。我刚核实，GitHub CLI 已成功登录 `liu123268`，授权也已保存，
  //    你不用再输入设备码。… 现在剩下的是发布设置：…所以需要你的选择，
  //    和登录无关。你回复「按推荐发布」，我就继续创建公开仓库并上传源码和便携包。"
  //
  // It was announced as `❓ 等你回答` for a turn the user read as FINISHED ("明明
  // 是完成任务") — and he was right. The rule matched the noun phrase **"需要你的
  // 选择"**, which is how the message EXPLAINS WHY the choice matters, not how it
  // asks. The actual handover in that message ("你回复 X，我就继续") carries no
  // question mark and no 请你, so no rule saw it.
  //
  // Audited across the 42 most recent main-thread Codex replies: 10 were flagged,
  // and this was the ONLY hit produced by a bare `需要你`. The other 9 all carry a
  // real signal — terminal `？`, 请你, or 回我 — and 5 of them are lesson questions
  // the user actually answered. So requiring `需要你` to be followed by something
  // other than 的 removes exactly this false positive and moves nothing else.
  //
  // Trade-off, stated plainly: a genuine bare plea ("需要你确认后我再继续") with no
  // question mark is now missed. Accepted — this rule is the noisy half of the pair,
  // and the exact signal (workbuddy's blocking `askPending`) is unaffected.
  //
  // ── And `需要你` may not match a NEGATED one either (same day, wider audit) ────
  // Widening the audit from 42 to 241 main-thread replies surfaced a second shape,
  // and a worse one: the rule was firing on **"不需要你…"** — a message explicitly
  // telling the user NOTHING is needed from them:
  //
  //   "…目前**不需要你**提供数据；如果你有博主公开的原始表格或代码，可以帮助核对口径，
  //    但不是继续研究的前置条件。"                    → announced as `❓ 等你回答`
  //   "…这次现有港指和宏观历史数据足够继续做回测，**不需要你**再提供一般行情数据…"
  //
  // "不需要你提供数据" is the exact opposite of a handover, yet the substring
  // `需要你` matched it. The lookbehind keeps both readings honest: the rule now only
  // fires when a request for the user is ACTUALLY being made (not negated, not
  // nominalised). Negation is checked in ASKING too, so the two halves agree on what
  // "asking wording" means.
  return ASKING.test(t) && /请你|麻烦你|等你|吗|呢|要不要|(?<!不)需要你(?!的)/.test(lastTwoSentences);
}

/** True when the turn reports that more work is still coming. */
function looksLikeContinuing(text) {
  return CONTINUING.test(tail(text));
}

/**
 * ── POLICY: may we CLAIM "the AI is waiting for you"? (2026-10-05, measured) ──
 *
 * `looksLikeQuestion` above is a heuristic. This is the decision of whether to trust it,
 * and the answer is now: NO, because it was measured against real behaviour and is mostly
 * wrong. The test used was "did the user actually answer?" — if a turn really ended by
 * asking the user something, the very next user message should be a short answer.
 *
 *   Codex      253 flagged turns → only 11 (4%)  were followed by an answer
 *   WorkBuddy  141 flagged turns →  0     (0%)   were followed by an answer
 *
 * The other 96–100% of the time the user simply moved on to something else
 * ("那c盘目录在哪…", "红字还是在…"). Those messages were teacher-style closing
 * questions, not blockers — and reporting them as `❓ 等你回答` is what made the user
 * distrust the one state that should mean "I am stuck, come help".
 *
 * WHY the marker approach can't replace it for these apps — and why that's not laziness:
 * WorkBuddy DOES have an explicit marker, the `AskUserQuestion` tool. But it is a
 * BLOCKING tool: the agent asks, the log waits, the human answers, and only then does the
 * turn finish. Verified on real data — 36 turns called it, 0 ended with it unanswered,
 * and the ask→answer gaps were 2272s / 76s / 144s (i.e. real human thinking time, and the
 * recorded result is the user's actual choice). So by construction, a WorkBuddy turn that
 * has ENDED cannot be blocked on a question. The same holds for ZCode (`waiting` is a
 * log-cleanup status).
 *
 * ⚠️ CORRECTED 2026-10-07 — the sentence that used to sit here said Codex "records no ask
 * event at all; `request_user_input_async` only appears inside instruction text". That was
 * WRONG, and it cost two missed notifications in a single evening: the user saw Codex ask
 * him something at 21:13 and again at 21:24 and his wristband never rang. It IS a real
 * `function_call` (async — it returns `{"accepted":true}` at once and the turn carries
 * on). Codex therefore DOES have an exact signal; see `askPending` in
 * src/agents/codex.js. **Never write "this app has no marker" without checking the raw
 * log for it — that claim is precisely what stops the next person from looking.**
 *
 * The only software that records "I am waiting" as a first-class field is DSH
 * (`userQuestions` / `plan`) — and that path does NOT come through here; it reads the
 * field directly. So: prefer the field, and do not guess.
 *
 * ── REVERSED again on 2026-10-05 (user decision) ─────────────────────────────
 * The measurement above says the text guess is mostly wrong, and it is. But it is the
 * ONLY signal available for these apps, and the user hit the cost of turning it off:
 *
 *   "WorkBuddy 提了一个问题，但发出来通知是已完成" — a turn that ended with three
 *   questions was announced as ✅ 已完成, so the notification said "done" while the AI
 *   was in fact waiting for an answer.
 *
 * The user was asked to choose between the two failure modes and picked this one
 * explicitly: **same body format as 已完成, but the title says 等你回答**. So the
 * default flips to ON. The OPTIONAL escape below stays — it is the surgical fix for the
 * one production false positive (a long delivery whose last sentence was a musing
 * "你觉得该不该…？"), and it is what keeps this from being the raw 4%/0% rule.
 *
 * Now an OPT-OUT: set BAND_NOTIFY_ASK_FROM_TEXT=0 to get the old "only DSH may say ❓"
 * behaviour back. If the ❓ noise becomes unbearable, that is the first thing to flip.
 */
const ASK_FROM_TEXT_OFF_RE = /^(0|false|no|off)$/i;

/** Read every call (not cached at load) so it can be toggled and tested. */
function askFromTextEnabled() {
  return !ASK_FROM_TEXT_OFF_RE.test(String(process.env.BAND_NOTIFY_ASK_FROM_TEXT || ''));
}

/**
 * The entry point adapters should use. Returns true ONLY when we may claim the AI is
 * blocked on the user.
 *
 * @param {string} text the turn's final assistant message
 */
function looksLikeAsk(text) {
  if (!askFromTextEnabled()) return false;
  return looksLikeQuestion(text);
}

module.exports = {
  looksLikeAsk,
  askFromTextEnabled,
  looksLikeQuestion,
  looksLikeContinuing,
  asksForSomething,
  TAIL_CHARS,
  DEFAULT_ASK_MAX_CHARS,
  OPTIONAL,
};
