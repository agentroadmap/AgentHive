To formalize the **`pipeline/`** domain, we must address the "AI Productivity Paradox": agents generate code 10x faster than humans, but that code contains 1.7x more logic errors and 2x more security vulnerabilities.

In your overhaul, the **`pipeline/`** isn't just a script; it’s a **Verification Layer** that acts as the final gatekeeper before any agent's work hits your Git `main` branch.

---

# Design Document: `pipeline/` Domain (The Gatekeeper)

## 1. The "Promotion" Workflow
Agents do not commit to `main`. They "promote" artifacts through a three-stage environment managed in SpacetimeDB.

| Stage | Location | Responsibility |
| :--- | :--- | :--- |
| **Draft** | `workforce/sandbox/` | Individual agent workspace. High-frequency commits. |
| **Stage** | `pipeline/staging/` | Automated testing. No human allowed here. |
| **Promoted** | `git:main` | The final "Clean" state. Only the **Auditor** can merge here. |

---

## 2. Automated Regression & Testing
Since you are using **OpenClaw** and **MCP**, your tests should be "Agentic"—meaning the tests themselves are run by specialized **QA Agents**.

* **The "Happy Path" Bot:** Uses Playwright or Selenium to walk through the UI as a user would.
* **The "Edge Case" Bot:** Specifically tries to "break" the new code by feeding it invalid inputs or triggering race conditions.
* **Self-Healing Tests:** If a UI change breaks a test, the **QA Agent** must first determine if the *code* is wrong or if the *test* needs updating. If the latter, it submits a "Test Update RFC" to you.

---

## 3. Automated Code Review (The "Sonar" Layer)
Every PR (Pull Request) initiated by a **Coder Agent** must pass a multi-step AI review before you ever see it.

* **Static Analysis (SAST):** Scans for "Vibe Coding" errors (e.g., hardcoded keys, missing error handling).
* **Semantic Review:** A **Senior Reviewer Agent** (using a high-reasoning model like Claude 3.5 Opus) checks if the code actually follows the **Product RFC** from the `product/` domain.
* **The 80% Confidence Rule:** If the AI reviewer is less than 80% sure a bug exists, it flags it as a "Observation." If it's >80% sure, it **Auto-Rejects** the PR and sends it back to the Coder Agent with fix instructions.

---

## 4. Security & Promotion Protocol
To ensure "Engineered Trust," the **`pipeline/`** enforces these 2026-standard security gates:

1.  **Dependency Check:** Scans `infrastructure/` for stale or malicious packages.
2.  **Secret Detection:** Prevents any `model/` apikeys from ever being committed to Git.
3.  **The Human "Kill-Switch":** Even if all tests pass, the final move to `main` requires a **one-click approval** from your **Mobile App** or **WebSash**.

---

## 5. Organizing the `pipeline/` Directory
* `pipeline/configs/`: YAML/JSON files defining what "Success" looks like for different project types.
* `pipeline/results/`: Logs of every test run, including screenshots/videos of the **OpenClaw** QA bots.
* `pipeline/promotions.json`: A ledger of every merge to `main`, linked to the **Workforce ID** of the agent who wrote it.

---

### **Architect’s Final Suggestion:**
Implement **"Shift-Left Security."** Don't wait until the `pipeline/` to find bugs. Give your **Coder Agents** access to a "Mini-Pipeline" MCP tool. This allows them to run a "Pre-flight Check" locally on their machine (Mac/Windows/Linux) before they even submit an RFC. It saves you token money by catching "dumb" errors before they hit the expensive high-reasoning Reviewer Agents.

