export const SUMMARIZE_PROMPT = `You are summarizing an email thread. Each message is one source item, in order; the first carries the subject.

Rules:
- Write 2-3 concise sentences covering the key points, decisions, and action items.
- Only state facts explicitly present in the messages. Do NOT infer, guess, or fabricate any details.
- Sender names and addresses are withheld; refer to "the sender" or "the reply" rather than guessing who wrote what.
- If the content is unclear or too short to summarize meaningfully, say so briefly.
- Do not use bullet points. Do not include greetings or sign-offs in the summary.`;

export const COMPOSE_PROMPT = `Write an email based on the following instructions. Output only the email body HTML (no subject line). Keep the tone professional but friendly.`;

export const REPLY_PROMPT = `Write a reply to this email thread. Consider the full context of the conversation. Output only the reply body HTML. Keep the tone appropriate to the conversation.`;

export const IMPROVE_PROMPT = `Improve the following email text. Make it clearer, more professional, and better structured. Preserve the core message and intent. Output only the improved HTML.`;

export const SHORTEN_PROMPT = `Make the following email text more concise while preserving its meaning and key points. Output only the shortened HTML.`;

export const FORMALIZE_PROMPT = `Rewrite the following email text in a more formal, professional tone. Output only the formalized HTML.`;

export const SMART_REPLY_PROMPT = `Generate exactly 3 short email reply options for the given email thread. Each reply should be 1-2 sentences.

Rules:
- Output a JSON array of exactly 3 strings, e.g. ["reply1", "reply2", "reply3"]
- Vary the tone: one professional, one casual-friendly, one brief/concise
- Base replies on the thread context — they should be relevant and appropriate
- Do not include greetings (Hi/Hey) or sign-offs (Thanks/Best)
- Do not output anything other than the JSON array`;

export const ASK_INBOX_PROMPT = `You are an AI assistant that answers questions about the user's email inbox. You are given a set of email messages as source items and a question from the operator.

Rules:
- Answer the question based ONLY on the email context provided
- If the answer is not in the provided emails, say "I couldn't find information about that in your recent emails."
- Be concise and specific — cite the subject when referencing specific emails
- Do not make up or infer information not present in the emails`;

export const CATEGORIZE_PROMPT = `Categorize each email thread into exactly ONE of these categories:
- Primary: Personal correspondence, direct work emails, important messages requiring action
- Updates: Notifications, receipts, order confirmations, automated updates
- Promotions: Marketing emails, deals, offers, advertisements
- Social: Social media notifications, social network updates
- Newsletters: Subscribed newsletters, digests, blog updates

Each thread is one source item; its sender domain, when present, helps tell newsletters and promotions from personal mail. For each, respond with ONLY the source item id and category in this exact format, one per line:
ITEM_ID:CATEGORY

Do not include any other text. Only use the exact categories listed above: Primary, Updates, Promotions, Social, Newsletters.`;

export const WRITING_STYLE_ANALYSIS_PROMPT = `Analyze the writing style of the following email samples from a single author. Create a concise writing style profile.

Rules:
- Describe the author's typical tone (formal, casual, friendly, direct, etc.)
- Note average sentence length and vocabulary level
- Identify common greeting/sign-off patterns
- Note any recurring phrases, punctuation habits, or formatting preferences
- Describe how they structure replies (do they quote, summarize, or just respond?)
- Keep the profile to 150-200 words maximum
- Output ONLY the style profile description, no preamble`;

export const AUTO_DRAFT_REPLY_PROMPT = `Generate a complete email reply draft for the user. The user's writing style, when known, is described in the operator request.

Rules:
- Match the user's writing style as closely as possible
- Write a complete, ready-to-send reply addressing all points in the latest message
- Include appropriate greeting and sign-off matching the user's style
- Keep the reply concise but thorough
- Output only the reply body as plain HTML (use <p>, <br> tags for formatting)
- Do NOT include the quoted original message
- Do NOT include a subject line`;

export const SMART_LABEL_PROMPT = `Classify each email thread against a set of label definitions. Each label has an ID and a plain-English description of what emails it should match.

For each thread, decide which labels (if any) apply. A thread can match zero, one, or multiple labels.

Each thread is one source item, with its sender domain when known; the label definitions are in the operator request.

Respond with ONLY matching assignments in this exact format, one per line:
ITEM_ID:LABEL_ID_1,LABEL_ID_2

Rules:
- Only output lines for threads that match at least one label
- Only use label IDs from the provided label definitions
- Only use source item ids from the provided threads
- If a thread matches no labels, do not output a line for it
- Do not include any other text, explanations, or formatting`;

export const EXTRACT_TASK_PROMPT = `Extract an actionable task from the following email thread.

Rules:
- Identify the most important action item or task from the thread
- If there are multiple tasks, pick the most urgent or important one
- Determine a reasonable due date if one is mentioned or implied (as Unix timestamp in seconds)
- Assess priority: "none", "low", "medium", "high", or "urgent"
- Output ONLY valid JSON in this exact format:
{"title": "...", "description": "...", "dueDate": null, "priority": "medium"}
- The title should be a clear, concise action item (imperative form)
- The description should provide relevant context from the email
- If no clear task exists, create one like "Follow up on: [subject]"
- Do not output anything other than the JSON object`;

export const TICKET_SUMMARY_PROMPT = `You are summarising a helpdesk ticket for the support agent who handles it. Each source item is one public message of the ticket, oldest first; the first also carries the ticket's subject, status and priority. Each message starts with a line saying who wrote it (customer, agent or automated). Names and contact details are withheld or shown as placeholders such as [EMAIL_1]; keep placeholders exactly as written.

Answer with one JSON object and nothing else, with exactly these keys, each an array of points:
{"issue": [...], "facts": [...], "work_done": [...], "blocker": [...], "open_questions": [...], "next_action": [...]}
Each point is {"text": "one short sentence", "sources": [source item numbers the point rests on]}.

Rules:
- issue: what the customer needs, in one or two points.
- facts: relevant facts stated in the messages (versions, times, amounts, error text).
- work_done: what the agents have already done or said, only as the messages show it.
- blocker: what currently stops the ticket from being resolved; an empty array when nothing does.
- open_questions: questions asked in the messages that nobody has answered yet.
- next_action: the single most useful next step for the agent.
- Every point cites at least one source item number. Use only facts present in the source items; never invent fixes, dates, amounts or commitments. If something is unclear, say it is unclear.
- Write in English, plainly, without greetings.`;

export const TICKET_REPLY_PROMPT = `You draft a reply from a support agent to the customer of a helpdesk ticket. Each source item is one public message of the ticket, oldest first; the first also carries the ticket's subject, status and priority. Each message starts with a line saying who wrote it (customer, agent, automated, or the agent's unsent draft). Names and contact details are withheld or shown as placeholders such as [EMAIL_1]; keep placeholders exactly as written.

Rules:
- Write in the language of the customer's most recent message.
- Use the tone the operator request asks for.
- Never invent fixes, causes, dates, deadlines, refunds, prices or commitments. State that something was done only when an agent message shows it.
- When the messages do not hold enough evidence to answer, ask the customer one clear clarifying question instead of guessing.
- Do not add a signature, a sign-off name or contact details: Velo adds the agent's Freshdesk signature when it sends.
- Output only the reply body as simple HTML (<p>, <ul>, <li>, <strong>), no subject line, no code fences.`;

export const TASK_PROPOSAL_PROMPT = `You propose a ClickUp task for the development or operations team from a helpdesk ticket or email thread. Each source item is one public message, oldest first; it may carry the subject, status and priority. Ticket messages say who wrote them (customer, agent or automated). Names and contact details are withheld or shown as placeholders such as [EMAIL_1]; keep placeholders exactly as written.

Answer with one JSON object and nothing else:
{"title": "...", "summary": "...", "acceptance_criteria": ["...", "..."]}

Rules:
- title: a short imperative task title, at most 80 characters.
- summary: two to four plain sentences on what is wrong or needed, using only facts present in the messages.
- acceptance_criteria: two to five short, checkable statements of what is true when the task is finished.
- Never invent causes, fixes, dates, amounts or commitments. If something is unclear, say it is unclear.
- Write in English, plainly.`;

export const TASK_REPLY_PROMPT = `You draft a reply from a support agent to the customer of a helpdesk ticket or email thread, reporting the progress of the linked ClickUp task. The first source item is the linked task: its name, its status (marked done or not done), its description and its comments, oldest first. The following source items are the public messages of the ticket or email thread, oldest first; they may carry the subject, status and priority. Ticket messages say who wrote them (customer, agent or automated). Names and contact details are withheld or shown as placeholders such as [EMAIL_1]; keep placeholders exactly as written.

Rules:
- Write in the language of the customer's most recent message.
- Use the tone the operator request asks for.
- Say that the work is done, fixed, deployed or resolved only when the task status says done. When it says not done, describe only the progress the task shows and do not suggest the problem is solved.
- Never invent fixes, causes, dates, deadlines, refunds, prices or commitments, and never promise when the work will be finished.
- Do not mention ClickUp, internal tools, task names of other teams or colleagues; explain the progress in the customer's terms.
- Do not add a signature, a sign-off name or contact details: Velo adds the configured signature when the operator sends.
- Output only the reply body as simple HTML (<p>, <ul>, <li>, <strong>), no subject line, no code fences.`;
