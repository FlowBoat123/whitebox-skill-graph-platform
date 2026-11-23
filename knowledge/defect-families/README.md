# Initial defect taxonomy

DefectLoop classifies each confirmed bug into exactly one primary defect family.
The family describes the failure mechanism, not the business screen where the
symptom appeared.

## Active families

| ID | Primary mechanism |
| --- | --- |
| `DF-UI_PRESENTATION` | Layout, responsive behavior and visual presentation |
| `DF-UI_STATE_INTERACTION` | UI state synchronization and interaction lifecycle |
| `DF-DATA_VALIDATION_CONTRACT` | Semantic input validation across boundaries |
| `DF-BUSINESS_RULE_WORKFLOW` | Domain rules and workflow state transitions |
| `DF-AUTHORIZATION_ACCESS` | Authentication, session and resource authorization |
| `DF-DATA_QUERY_PERSISTENCE` | Query, mapping, pagination and transactional persistence |
| `DF-FILE_PROCESSING` | Upload, download, preview, import and export |
| `DF-INTEGRATION_PROTOCOL` | Request/response and service integration contracts |
| `DF-RELIABILITY_CONCURRENCY` | Retry, idempotency, concurrency, timeout and resource failure |
| `DF-SECURITY_DATA_PROTECTION` | Unsafe input handling and sensitive-data exposure |

## Classification rule

Classify by the direct technical mechanism established by root-cause evidence.
Do not classify only from the visible symptom. For example, an error message on
a form caused by an API schema mismatch belongs to `DF-INTEGRATION_PROTOCOL`,
not a UI family.

When evidence is insufficient, intake may temporarily return
`DF-NEEDS_TRIAGE`. This is a candidate state and must never be promoted as a
confirmed defect family.

Business areas such as authentication, submissions, martyr records, reporting,
data warehouse and system administration will be modeled later as feature
scopes. Feature scopes are orthogonal to defect families: the same mechanism can
occur in many features, and one feature can contain bugs from many families.
