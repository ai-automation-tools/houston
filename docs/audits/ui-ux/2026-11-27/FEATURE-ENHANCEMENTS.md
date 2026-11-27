# Feature enhancement backlog

Each item supports Houston's developer workbench purpose. These are proposals, not implementation commitments.

| ID | Opportunity | User problem and value | Suggested scope | Priority / effort |
|---|---|---|---|---|
| F01 | Saved panel views | Operators repeatedly narrow large Cron and Logs datasets. | Save local filter choices per workspace/profile, with a visible reset; never persist sensitive log content. | P2 / Medium |
| F02 | Unified panel switcher | Twelve sidebar sections are difficult to discover and scan in icon mode. | Searchable menu of all sections with names, status/count badges and keyboard access; reuse command palette navigation registry. | P2 / Medium |
| F03 | “Open workspace” guided action | Git, Dev and Agents show no-folder empty states in Default workspace. | Guide selection of a Hub folder, then return to the initiating panel. | P2 / Small |
| F04 | Cron task finder | A 500-task list makes known-task lookup slow. | Search and filter with result count; optionally pin frequently inspected tasks. Keep Run actions protected by existing confirmation. | P2 / Medium |
| F05 | Diagnostic report shortcut | Health offers a diagnostics bundle via View menu, but issue reporting remains multi-step. | A read-only copyable health summary with explicit redaction; keep bundle generation local and user initiated. | P3 / Small |

Avoid adding cloud accounts, remote sync, direct Git writes, or automated task execution as part of these proposals; those would change the app's documented scope and safety model.
