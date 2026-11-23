import fs from "node:fs";
import path from "node:path";

export type EvoBenchApp = "cypress-rwa" | "horilla";
export type EvoBenchCategory = "SKILL_DRIFT" | "PRODUCT_BUG" | "NO_IMPACT";

export interface EvoMutationSpec {
  id: string;
  app: EvoBenchApp;
  category: EvoBenchCategory;
  title: string;
  targetFile: string;
  /** Whether modifying this file requires backend/worker reload wait (e.g. Python CBV or Express route). */
  requiresBackendReload: boolean;
  expectedImpactedSkills: string[];
  /** Primary skill & goal used to evaluate execution/healing on this commit. */
  primarySkillId?: string;
  verifyGoal?: { name: string; params: Record<string, string> };
  extraBindings?: Record<string, string>;
  /** Deterministic mutation transform applied to targetFile content. Throws if anchor is not found. */
  mutate: (content: string) => string;
}

function replaceExact(content: string, needle: string | RegExp, replacement: string, id: string): string {
  const next = content.replace(needle, replacement);
  if (next === content) {
    throw new Error(`EvoBench-24 mutation ${id} failed: anchor not found.`);
  }
  return next;
}

export const EVOBENCH_24: EvoMutationSpec[] = [
  // =========================================================================
  // CATEGORY A: INTENTIONAL UI EVOLUTION (SKILL_DRIFT) — 8 Commits (5 RWA + 3 Horilla)
  // =========================================================================
  {
    id: "RWA-D1",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename BankAccountForm submit button 'Save' -> 'Confirm Account'",
    targetFile: "src/components/BankAccountForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.create"],
    primarySkillId: "bank.create",
    verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "EvoBench Bank D1" } },
    mutate: (c) =>
      replaceExact(
        c,
        />\r?\n\s+Save\r?\n\s+<\/Button>/,
        ">\n                Confirm Account\n              </Button>",
        "RWA-D1",
      ),
  },
  {
    id: "RWA-D2",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename SignInForm submit button 'Sign In' -> 'Log Into Account'",
    targetFile: "src/components/SignInForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["auth.signin"],
    primarySkillId: "auth.signin",
    verifyGoal: { name: "auth.logged_in", params: { user: "Heath93" } },
    mutate: (c) => replaceExact(c, /Sign In\s*<\/Button>/, "Log Into Account\n              </Button>", "RWA-D2"),
  },
  {
    id: "RWA-D3",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename BankAccountForm placeholder 'Bank Name' -> 'Institution Name'",
    targetFile: "src/components/BankAccountForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.create"],
    primarySkillId: "bank.create",
    verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "EvoBench Bank D3" } },
    mutate: (c) => replaceExact(c, 'placeholder="Bank Name"', 'placeholder="Institution Name"', "RWA-D3"),
  },
  {
    id: "RWA-D4",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename TransactionCreateStepTwo button 'Request' -> 'Ask Payment'",
    targetFile: "src/components/TransactionCreateStepTwo.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.create_payment", "tx.create_request"],
    primarySkillId: "tx.create_request",
    verifyGoal: {
      name: "tx.pending_request",
      params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "EvoBench Req D4" },
    },
    mutate: (c) => replaceExact(c, /Request\s*<\/Button>/, "Ask Payment\n                  </Button>", "RWA-D4"),
  },
  {
    id: "RWA-D5",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Structural form change: add required 'Branch Code' input + Yup schema to BankAccountForm",
    targetFile: "src/components/BankAccountForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.create"],
    primarySkillId: "bank.create",
    verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "EvoBench Bank D5" } },
    extraBindings: { branchCode: "NYC-101" },
    mutate: (c) => {
      let out = replaceExact(
        c,
        'bankName: string().min(5, "Must contain at least 5 characters").required("Enter a bank name"),',
        'bankName: string().min(5, "Must contain at least 5 characters").required("Enter a bank name"),\n  branchCode: string().min(3, "Must contain at least 3 characters").required("Enter a branch code"),',
        "RWA-D5-yup",
      );
      out = replaceExact(
        out,
        'routingNumber: "",',
        'routingNumber: "",\n    branchCode: "",',
        "RWA-D5-init",
      );
      out = replaceExact(
        out,
        "const initialValues: BankAccountPayload = {",
        "const initialValues: BankAccountPayload & { branchCode: string } = {",
        "RWA-D5-type",
      );
      const branchField = `<Field name="branchCode">
            {({ field, meta: { error, value, initialValue, touched } }: FieldProps) => (
              <TextField
                variant="outlined"
                margin="dense"
                fullWidth
                required
                id={"bankaccount-branchCode-input"}
                type="text"
                placeholder="Branch Code"
                data-test={"bankaccount-branchCode-input"}
                error={(touched || value !== initialValue) && Boolean(error)}
                helperText={touched || value !== initialValue ? error : ""}
                {...field}
              />
            )}
          </Field>
          <Grid`;
      out = replaceExact(out, /<Grid\r?\n\s+container/, `${branchField}\n            container`, "RWA-D5-field");
      return out;
    },
  },
  {
    id: "HOR-D1",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Django login button 'Sign In' -> 'Access Workspace'",
    targetFile: "horilla_theme/templates/login.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["auth.login"],
    primarySkillId: "auth.login",
    verifyGoal: { name: "auth.logged_in", params: { user: "hr_admin" } },
    mutate: (c) => replaceExact(c, '{% trans "Sign In" %}', '{% trans "Access Workspace" %}', "HOR-D1"),
  },
  {
    id: "HOR-D2",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Horilla nav button 'Create' -> 'New Entry'",
    targetFile: "horilla_theme/templates/generic/horilla_nav.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench Dept D2" } },
    mutate: (c) => replaceExact(c, '{% trans "Create" %}', '{% trans "New Entry" %}', "HOR-D2"),
  },
  {
    id: "HOR-D3",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Horilla modal submit button 'Save' -> 'Confirm Record'",
    targetFile: "horilla_theme/templates/generic/form.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["department.create", "employee_type.create"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench Dept D3" } },
    mutate: (c) => replaceExact(c, "{% trans 'Save' %}", "{% trans 'Confirm Record' %}", "HOR-D3"),
  },

  // =========================================================================
  // CATEGORY B: REAL PRODUCT REGRESSIONS (PRODUCT_BUG) — 10 Commits (6 RWA + 4 Horilla)
  // =========================================================================
  {
    id: "RWA-B1",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Swallowed 'Accept Request' click handler in TransactionDetail.tsx",
    targetFile: "src/components/TransactionDetail.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.respond_request"],
    primarySkillId: "tx.respond_request",
    verifyGoal: {
      name: "tx.resolved",
      params: {
        sender: "Heath93",
        receiver: "Arvilla_Hegmann",
        note: "EvoBench Bug B1",
        decisionLabel: "Accept Request",
      },
    },
    mutate: (c) =>
      replaceExact(
        c,
        /onClick=\{\(\) =>\s*transactionUpdate\(\{\s*id: transaction\.id,\s*requestStatus: TransactionRequestStatus\.accepted,\s*\}\)\s*\}/m,
        "onClick={() => { /* regression: swallowed click */ }}",
        "RWA-B1",
      ),
  },
  {
    id: "RWA-B2",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Runtime exception inside BankAccountForm onSubmit handler",
    targetFile: "src/components/BankAccountForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.create"],
    primarySkillId: "bank.create",
    verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "EvoBench Bug B2" } },
    mutate: (c) =>
      replaceExact(
        c,
        "createBankAccount({ ...values, userId });",
        'throw new Error("Simulated bank account submit crash");',
        "RWA-B2",
      ),
  },
  {
    id: "RWA-B3",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Swallowed 'Delete' button click handler in BankAccountItem.tsx",
    targetFile: "src/components/BankAccountItem.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.delete"],
    primarySkillId: "bank.delete",
    verifyGoal: { name: "bank.deleted", params: { user: "Heath93", bankName: "EvoBench Bug B3" } },
    mutate: (c) =>
      replaceExact(
        c,
        "deleteBankAccount({ id: bankAccount.id });",
        "/* regression: swallowed deleteBankAccount */",
        "RWA-B3",
      ),
  },
  {
    id: "RWA-B4",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Backend GraphQL crash in Mutation.createBankAccount (backend/graphql/resolvers/Mutation.ts)",
    targetFile: "backend/graphql/resolvers/Mutation.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["bank.create", "bank.delete", "tx.comment"],
    primarySkillId: "bank.create",
    verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "EvoBench Bug B4" } },
    mutate: (c) =>
      replaceExact(
        c,
        "return createBankAccountForUser(ctx.user.id, args);",
        'throw new Error("Simulated GraphQL DB write crash");',
        "RWA-B4",
      ),
  },
  {
    id: "RWA-B5",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Swallowed comment submission inside CommentForm.tsx onSubmit",
    targetFile: "src/components/CommentForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.comment"],
    primarySkillId: "tx.comment",
    verifyGoal: {
      name: "tx.commented",
      params: {
        sender: "Heath93",
        note: "EvoBench Bug B5",
        commentText: "Should fail silently",
      },
    },
    extraBindings: { receiver: "Arvilla_Hegmann" },
    mutate: (c) =>
      replaceExact(
        c,
        "transactionComment({ transactionId, ...values });",
        "/* regression: swallowed comment submit */",
        "RWA-B5",
      ),
  },
  {
    id: "RWA-B6",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Silent persistence drop in backend POST /comments (returns HTTP 200 without saving)",
    targetFile: "backend/comment-routes.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["tx.comment"],
    primarySkillId: "tx.comment",
    verifyGoal: {
      name: "tx.commented",
      params: {
        sender: "Heath93",
        note: "EvoBench Bug B6",
        commentText: "Dropped on server",
      },
    },
    extraBindings: { receiver: "Arvilla_Hegmann" },
    mutate: (c) =>
      replaceExact(
        c,
        "createComments(req.user?.id!, transactionId, content);",
        "/* regression: skipped createComments before HTTP 200 */",
        "RWA-B6",
      ),
  },
  {
    id: "HOR-B1",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Silent persistence bug in Django DepartmentCreateForm (skips form.save(), returns HTTP 200)",
    targetFile: "base/cbv/department.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench Dept B1" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        "            # regression: skipped form.save() before returning HTTP 200",
        "HOR-B1",
      ),
  },
  {
    id: "HOR-B2",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 500 RuntimeError in Django DepartmentCreateForm.form_valid",
    targetFile: "base/cbv/department.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench Dept B2" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        '            raise RuntimeError("Simulated DB transaction failure in DepartmentCreateForm")',
        "HOR-B2",
      ),
  },
  {
    id: "HOR-B3",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Silent persistence bug in Django EmployeeTypeFormView (skips form.save(), returns HTTP 200)",
    targetFile: "base/cbv/employee_type.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["employee_type.create"],
    primarySkillId: "employee_type.create",
    verifyGoal: { name: "employee_type.exists", params: { employeeType: "EvoBench Type B3" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        "            # regression: skipped form.save() on EmployeeTypeFormView",
        "HOR-B3",
      ),
  },
  {
    id: "HOR-B4",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Broken authentication in Django login_user (forces user = None after authenticate)",
    targetFile: "base/views.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["auth.login"],
    primarySkillId: "auth.login",
    verifyGoal: { name: "auth.logged_in", params: { user: "hr_admin" } },
    mutate: (c) =>
      replaceExact(
        c,
        "        user = authenticate(request, username=username, password=password)",
        "        user = None  # regression: broken authentication check",
        "HOR-B4",
      ),
  },

  // =========================================================================
  // CATEGORY C: UNRELATED CODE / DOC COMMITS (NO_IMPACT) — 6 Commits (3 RWA + 3 Horilla)
  // =========================================================================
  {
    id: "RWA-N1",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Documentation update in cypress-rwa README.md",
    targetFile: "README.md",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `${c}\n<!-- EvoBench-24 RWA-N1 unrelated doc edit -->\n`,
  },
  {
    id: "RWA-N2",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Unrelated footer copy edit in src/components/Footer.tsx",
    targetFile: "src/components/Footer.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => replaceExact(c, "Built by", "Crafted by", "RWA-N2"),
  },
  {
    id: "RWA-N3",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Unrelated refactor comment in src/components/NotificationList.tsx",
    targetFile: "src/components/NotificationList.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `// EvoBench-24 RWA-N3 unrelated comment\n${c}`,
  },
  {
    id: "HOR-N1",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Documentation update in horilla README.md",
    targetFile: "README.md",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `${c}\n<!-- EvoBench-24 HOR-N1 unrelated doc edit -->\n`,
  },
  {
    id: "HOR-N2",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Unrelated docstring update in base/cbv/company.py",
    targetFile: "base/cbv/company.py",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `# EvoBench-24 HOR-N2 unrelated comment\n${c}`,
  },
  {
    id: "HOR-N3",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Unrelated template comment in horilla_theme/templates/floating_button.html",
    targetFile: "horilla_theme/templates/floating_button.html",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `{# EvoBench-24 HOR-N3 unrelated comment #}\n${c}`,
  },
];

export function applyEvoMutation(sandboxRoot: string, spec: EvoMutationSpec): string {
  const fullPath = path.join(sandboxRoot, spec.targetFile);
  const orig = fs.readFileSync(fullPath, "utf8");
  const next = spec.mutate(orig);
  if (next === orig) {
    throw new Error(`Mutation ${spec.id} produced identical content for ${spec.targetFile}`);
  }
  fs.writeFileSync(fullPath, next, "utf8");
  return fullPath;
}
