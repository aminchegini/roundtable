# Disclaimer

**Read this before using Roundtable. By installing, building, running or otherwise using this software you accept everything below. If you do not accept it, do not use it.**

Roundtable is an independent, open-source project by Emin Hikmet ("the author"), released under the [MIT License](LICENSE). This disclaimer supplements that license; where they overlap, the broader protection for the author and contributors applies.

## 1. Not affiliated with any vendor

Roundtable is **not affiliated with, endorsed by, sponsored by, or supported by** Anthropic, OpenAI, Google, GitHub, Microsoft, Cursor, or any other company whose tools it can drive. "Claude", "Claude Code", "Codex", "ChatGPT", "Gemini", "GitHub Copilot" and "Cursor" are trademarks of their respective owners, used here only to identify the software Roundtable can connect to.

## 2. Your accounts, your terms, your responsibility

Roundtable does not provide AI models or access to them. It runs each vendor's **own** command-line agent or SDK on **your** machine, using the login or API key **you** configured. Every model call, tool call, file edit, shell command and network request an agent makes happens **under your account** and is governed by **that vendor's** terms of service, usage policies, rate limits and pricing — not by Roundtable.

You alone are responsible for:

- confirming that your plan and the vendor's terms permit the way Roundtable uses the vendor's tools (including automation, headless use and third-party clients, which vary by vendor and change over time);
- every token, request, credit, premium request, quota consumption, rate-limit hit, overage, charge and fee incurred on any account while Roundtable is running, **whether expected or not, and whether caused by you, by an agent, by a bug, or by a misconfiguration**;
- any suspension, restriction or termination of an account by a vendor;
- reviewing and accepting what agents do in your repositories and on your machine.

## 3. Costs, tokens and quotas: estimates only — no guarantees

Agents can consume large amounts of tokens quickly, especially in rooms with several agents, long debates, large repositories, or when an agent retries or loops. **Roundtable makes no guarantee about how much any session, room or feature will cost or consume.**

Any dollar figure, token count, percentage, "remaining", budget, cap or quota that Roundtable displays is an **approximation** derived from information a vendor's tool happens to report. It may be delayed, incomplete, inaccurate or missing entirely. Budget caps and round caps are **best-effort conveniences**, not controls you can rely on to limit spending. The vendor's own dashboard and invoice are the only authoritative sources.

**The author and contributors are not liable for any tokens burned, credits used, quotas exhausted, overages, subscription charges, API charges, or any other cost or loss of any kind arising from the use of this software.**

## 4. Agents change things

Agents can read, create, modify and delete files, run arbitrary shell commands, create commits and branches, install packages, and call network services, within the permissions you grant and sometimes beyond what you intended. Guardrails and permission prompts **reduce** risk; they do not eliminate it, their enforcement differs by vendor (see [docs/providers.md](docs/providers.md)), and they can fail. Use version control, back up your data, review changes before trusting them, and never point agents at systems, credentials or data you cannot afford to lose, leak or corrupt.

## 5. No warranty, no guarantee

THE SOFTWARE IS PROVIDED **"AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OR GUARANTEE OF ANY KIND**, EXPRESS, IMPLIED, STATUTORY OR OTHERWISE, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, RELIABILITY, AVAILABILITY, SECURITY, OR THAT IT WILL BE ERROR-FREE, UNINTERRUPTED, OR COMPATIBLE WITH ANY VENDOR'S TOOLS OR TERMS NOW OR IN THE FUTURE. Vendors change their tools, APIs, pricing and terms without notice; Roundtable may stop working or behave differently at any time.

## 6. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE AUTHOR, COPYRIGHT HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY — WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY OR OTHERWISE — INCLUDING WITHOUT LIMITATION **DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES; LOSS OF MONEY, TOKENS, CREDITS, QUOTA, DATA, PROFITS, REVENUE, GOODWILL OR BUSINESS; ACCOUNT SUSPENSION OR TERMINATION; UNAUTHORISED ACCESS; OR THE COST OF SUBSTITUTE SERVICES** — ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE, ITS USE OR INABILITY TO USE, OR ANYTHING AN AI AGENT DOES OR FAILS TO DO WHILE DRIVEN BY IT, **EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES**. Where liability cannot be excluded by law, it is limited to the greatest extent the law allows, and in any case to the amount you paid the author for the software, which is zero.

## 7. Assumption of risk and indemnity

You use Roundtable **entirely at your own risk**. You agree to indemnify and hold harmless the author and contributors from any claim, demand, loss, liability, cost or expense (including reasonable legal fees) arising from your use of the software, your violation of any vendor's terms, or anything an agent does under your accounts.

## 8. Not professional advice

Nothing produced by agents through Roundtable is professional, legal, financial, security or engineering advice. Output may be wrong, insecure or harmful. You are responsible for verifying it.

## 9. Changes

This disclaimer may change as the software changes. The version in the repository at the time you use the software applies.

---

*This document is written in plain language by a developer, not a lawyer, and is not legal advice. If you need certainty about liability in your jurisdiction, consult counsel.*
