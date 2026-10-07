# Disclaimer

Roundtable is an independent, open-source project by Emin Hikmet. Please read this before using it.

## Not affiliated

Roundtable is **not affiliated with, endorsed by, or sponsored by** Anthropic, OpenAI, Google, GitHub, Microsoft, Cursor, or any other vendor whose tools it drives. "Claude", "Codex", "ChatGPT", "Gemini", "GitHub Copilot" and "Cursor" are trademarks of their respective owners and are used here only to identify the software Roundtable can connect to.

## Your accounts, your terms

Roundtable runs each vendor's **own** command-line agent or SDK on your machine, using the login or API key **you** configured for that vendor. Everything an agent does — model calls, tool use, file edits, shell commands — happens under your account and is governed by **that vendor's terms of service, usage policies and pricing**. You are responsible for:

- having the right to use each vendor's tools in the way Roundtable uses them (including automation and third-party-client terms, which differ by vendor and plan);
- the usage, rate limits and charges those accounts incur;
- reviewing what agents do in your repositories.

## Costs and quotas are estimates

Any dollar figure Roundtable shows is an **approximation** derived from what a vendor's tool reports, not a bill. Subscription usage percentages are read from vendor-reported rate-limit information when available and may lag, be missing, or be wrong. Token counts are as reported by the vendor. Roundtable's budget caps are best-effort safeguards, not guarantees. Always check your vendor's own dashboard for authoritative usage and billing.

## Agents change things

Agents can read, create, modify and delete files, run shell commands, make commits, and call network services within the permissions you grant them. Guardrails reduce risk but do not eliminate it, and their enforcement differs by vendor (see [docs/providers.md](docs/providers.md)). Use version control, review changes before trusting them, and do not point agents at data you cannot afford to lose or leak.

## No warranty, no liability

Roundtable is provided **"as is", without warranty of any kind**, express or implied. To the maximum extent permitted by law, the author and contributors are **not liable** for any claim, damages, loss of data, loss of money, account suspension, or other liability arising from the use of this software, including anything an AI agent does while driven by it. See the [MIT License](LICENSE) for the full terms.

By using Roundtable you accept this disclaimer.
