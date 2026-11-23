import { EVOBENCH_24, type EvoMutationSpec } from "./evobench-24.js";

function replaceExact(content: string, find: string | RegExp, replacement: string, id: string): string {
  const next = content.replace(find, replacement);
  if (next === content) {
    throw new Error(`EvoBench-48 mutation '${id}' failed: target pattern not found.`);
  }
  return next;
}

/**
 * 24 brand-new, non-overlapping mutations across Cypress RWA (12) and Horilla HRMS (12):
 * - +8 Category A (SKILL_DRIFT): 4 RWA + 4 Horilla
 * - +10 Category B (PRODUCT_BUG): 5 RWA + 5 Horilla
 * - +6 Category C (NO_IMPACT): 3 RWA + 3 Horilla
 */
export const EVOBENCH_24_EXTENSION: EvoMutationSpec[] = [
  // =========================================================================
  // CATEGORY A EXTENSION: +8 UI SKILL DRIFT (4 RWA + 4 Horilla)
  // =========================================================================
  {
    id: "RWA-D6",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename SignInForm username label 'Username' -> 'Account Handle'",
    targetFile: "src/components/SignInForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["auth.signin"],
    primarySkillId: "auth.signin",
    verifyGoal: { name: "auth.logged_in", params: { user: "Heath93" } },
    mutate: (c) => replaceExact(c, 'label="Username"', 'label="Account Handle"', "RWA-D6"),
  },
  {
    id: "RWA-D7",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename CommentForm placeholder 'Write a comment...' -> 'Add a transaction note...'",
    targetFile: "src/components/CommentForm.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.comment"],
    primarySkillId: "tx.comment",
    verifyGoal: {
      name: "tx.commented",
      params: { sender: "Heath93", note: "EvoBench48 D7 Tx", commentText: "EvoBench48 D7 Note" },
    },
    extraBindings: { receiver: "Arvilla_Hegmann" },
    mutate: (c) =>
      replaceExact(c, 'placeholder="Write a comment..."', 'placeholder="Add a transaction note..."', "RWA-D7"),
  },
  {
    id: "RWA-D8",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename TransactionCreateStepTwo button 'Request' -> 'Ask Funds'",
    targetFile: "src/components/TransactionCreateStepTwo.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.create_payment", "tx.create_request"],
    primarySkillId: "tx.create_request",
    verifyGoal: {
      name: "tx.pending_request",
      params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "EvoBench48 D8 Req" },
    },
    mutate: (c) =>
      replaceExact(
        c,
        /onClick=\{\(\) => setTransactionType\("request"\)\}\r?\n\s*>\r?\n\s*Request/,
        'onClick={() => setTransactionType("request")}\n                  >\n                    Ask Funds',
        "RWA-D8",
      ),
  },
  {
    id: "RWA-D9",
    app: "cypress-rwa",
    category: "SKILL_DRIFT",
    title: "Rename BankAccountItem button 'Delete' -> 'Remove Account'",
    targetFile: "src/components/BankAccountItem.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["bank.delete"],
    primarySkillId: "bank.delete",
    verifyGoal: { name: "bank.deleted", params: { user: "Heath93", bankName: "EvoBench48 D9 Bank" } },
    mutate: (c) =>
      replaceExact(
        c,
        /deleteBankAccount\(\{ id: bankAccount\.id \}\);\r?\n\s*\}\}\r?\n\s*>\r?\n\s*Delete/,
        'deleteBankAccount({ id: bankAccount.id });\n              }}\n            >\n              Remove Account',
        "RWA-D9",
      ),
  },
  {
    id: "HOR-D4",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Django DepartmentForm placeholder 'Department' -> 'Department Title' in Python base/forms.py",
    targetFile: "base/forms.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["department.create", "employee_type.create"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench48 Dept D4" } },
    mutate: (c) =>
      replaceExact(
        c,
        '    def __init__(self, *args, **kwargs):\n        super().__init__(*args, **kwargs)\n        # Manager can be any employee',
        '    def __init__(self, *args, **kwargs):\n        super().__init__(*args, **kwargs)\n        self.fields["department"].widget.attrs["placeholder"] = "Department Title"\n        # Manager can be any employee',
        "HOR-D4",
      ),
  },
  {
    id: "HOR-D5",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename generic form modal submit button 'Save' -> 'Submit Record'",
    targetFile: "horilla_theme/templates/generic/form.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["department.create", "employee_type.create"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench48 Dept D5" } },
    mutate: (c) => replaceExact(c, "{% trans 'Save' %}", "{% trans 'Submit Record' %}", "HOR-D5"),
  },
  {
    id: "HOR-D6",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Django login username label 'Username' -> 'Employee ID'",
    targetFile: "horilla_theme/templates/login.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["auth.login"],
    primarySkillId: "auth.login",
    verifyGoal: { name: "auth.logged_in", params: { user: "hr_admin" } },
    mutate: (c) => replaceExact(c, '{% trans "Username" %}', '{% trans "Employee ID" %}', "HOR-D6"),
  },
  {
    id: "HOR-D7",
    app: "horilla",
    category: "SKILL_DRIFT",
    title: "Rename Horilla nav search input placeholder 'Search' -> 'Filter Records'",
    targetFile: "horilla_theme/templates/generic/horilla_nav.html",
    requiresBackendReload: false,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.search",
    verifyGoal: { name: "department.filtered", params: { department: "EvoBench48 Dept D7" } },
    mutate: (c) =>
      replaceExact(c, `placeholder="{% trans 'Search' %}"`, `placeholder="{% trans 'Filter Records' %}"`, "HOR-D7"),
  },

  // =========================================================================
  // CATEGORY B EXTENSION: +10 REAL PRODUCT BUGS (5 RWA + 5 Horilla)
  // =========================================================================
  {
    id: "RWA-B7",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 500 throw inside POST /transactions (backend/transaction-routes.ts)",
    targetFile: "backend/transaction-routes.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["tx.create_payment", "tx.create_request", "tx.respond_request"],
    primarySkillId: "tx.create_payment",
    verifyGoal: {
      name: "tx.paid",
      params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "EvoBench48 B7 Crash" },
    },
    mutate: (c) =>
      replaceExact(
        c,
        "const transaction = createTransaction(req.user?.id!, transactionType, transactionPayload);",
        'throw new Error("Simulated ledger persistence failure on POST /transactions");',
        "RWA-B7",
      ),
  },
  {
    id: "RWA-B8",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 422 contract regression on POST /transactions (backend/transaction-routes.ts)",
    targetFile: "backend/transaction-routes.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["tx.create_payment", "tx.create_request", "tx.respond_request"],
    primarySkillId: "tx.create_request",
    verifyGoal: {
      name: "tx.pending_request",
      params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "EvoBench48 B8 Validation" },
    },
    mutate: (c) =>
      replaceExact(
        c,
        "const transaction = createTransaction(req.user?.id!, transactionType, transactionPayload);",
        'return res.status(422).json({ error: "Simulated transaction contract validation regression" });',
        "RWA-B8",
      ),
  },
  {
    id: "RWA-B9",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 500 error in POST /login response serialization (backend/auth.ts)",
    targetFile: "backend/auth.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["auth.signin", "auth.signout"],
    primarySkillId: "auth.signin",
    verifyGoal: { name: "auth.logged_in", params: { user: "Heath93" } },
    mutate: (c) =>
      replaceExact(
        c,
        "res.send({ user: req.user });",
        'res.status(500).json({ error: "Simulated session serialization failure" });',
        "RWA-B9",
      ),
  },
  {
    id: "RWA-B10",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "Swallowed payment submission inside TransactionCreateStepTwo.tsx onSubmit",
    targetFile: "src/components/TransactionCreateStepTwo.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: ["tx.create_payment", "tx.create_request"],
    primarySkillId: "tx.create_payment",
    verifyGoal: {
      name: "tx.paid",
      params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "EvoBench48 B10 Swallowed" },
    },
    mutate: (c) =>
      replaceExact(
        c,
        "createTransaction({ transactionType, ...values });",
        "/* regression: swallowed createTransaction submission */",
        "RWA-B10",
      ),
  },
  {
    id: "RWA-B11",
    app: "cypress-rwa",
    category: "PRODUCT_BUG",
    title: "GraphQL Mutation.deleteBankAccount throws unhandled server exception",
    targetFile: "backend/graphql/resolvers/Mutation.ts",
    requiresBackendReload: true,
    expectedImpactedSkills: ["bank.create", "bank.delete", "tx.comment"],
    primarySkillId: "bank.delete",
    verifyGoal: { name: "bank.deleted", params: { user: "Heath93", bankName: "EvoBench48 B11 Bank" } },
    mutate: (c) =>
      replaceExact(
        c,
        "removeBankAccountById(args.id);",
        'throw new Error("Simulated GraphQL deleteBankAccount failure");',
        "RWA-B11",
      ),
  },
  {
    id: "HOR-B5",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 500 RuntimeError in Django EmployeeTypeFormView.form_valid",
    targetFile: "base/cbv/employee_type.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["employee_type.create"],
    primarySkillId: "employee_type.create",
    verifyGoal: { name: "employee_type.exists", params: { employeeType: "EvoBench48 Type B5" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        '            raise RuntimeError("Simulated DB crash in EmployeeTypeFormView")',
        "HOR-B5",
      ),
  },
  {
    id: "HOR-B6",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Backend HTTP 500 RuntimeError in Django login_user (base/views.py)",
    targetFile: "base/views.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["auth.login"],
    primarySkillId: "auth.login",
    verifyGoal: { name: "auth.logged_in", params: { user: "hr_admin" } },
    mutate: (c) =>
      replaceExact(
        c,
        /        user = authenticate\(request, username=username, password=password\)\r?\n\r?\n        if not user:/,
        '        raise RuntimeError("Simulated auth session store failure")\n\n        if not user:',
        "HOR-B6",
      ),
  },
  {
    id: "HOR-B7",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "Broken DepartmentListView queryset regression (always returns empty queryset)",
    targetFile: "base/cbv/department.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.search",
    verifyGoal: { name: "department.filtered", params: { department: "EvoBench48 Dept B7" } },
    mutate: (c) =>
      replaceExact(
        c,
        "    model = Department\n    filter_class = DepartmentViewFilter",
        "    model = Department\n    filter_class = DepartmentViewFilter\n\n    def get_queryset(self):\n        return Department.objects.none()",
        "HOR-B7",
      ),
  },
  {
    id: "HOR-B8",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "HTTP 400 validation regression in Django DepartmentCreateForm.form_valid",
    targetFile: "base/cbv/department.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["department.create", "department.search"],
    primarySkillId: "department.create",
    verifyGoal: { name: "department.exists", params: { department: "EvoBench48 Dept B8" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        '            return HttpResponse("Bad department payload", status=400)',
        "HOR-B8",
      ),
  },
  {
    id: "HOR-B9",
    app: "horilla",
    category: "PRODUCT_BUG",
    title: "HTTP 403 permission regression in Django EmployeeTypeFormView.form_valid",
    targetFile: "base/cbv/employee_type.py",
    requiresBackendReload: true,
    expectedImpactedSkills: ["employee_type.create"],
    primarySkillId: "employee_type.create",
    verifyGoal: { name: "employee_type.exists", params: { employeeType: "EvoBench48 Type B9" } },
    mutate: (c) =>
      replaceExact(
        c,
        "            form.save()",
        '            return HttpResponse("Permission denied regression", status=403)',
        "HOR-B9",
      ),
  },

  // =========================================================================
  // CATEGORY C EXTENSION: +6 UNRELATED CODE / DOC COMMITS (NO_IMPACT)
  // =========================================================================
  {
    id: "RWA-N4",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Unrelated comment update in src/components/AlertBar.tsx",
    targetFile: "src/components/AlertBar.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `// EvoBench-48 RWA-N4 unrelated comment\n${c}`,
  },
  {
    id: "RWA-N5",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Unrelated comment update in src/components/EmptyList.tsx",
    targetFile: "src/components/EmptyList.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `// EvoBench-48 RWA-N5 unrelated comment\n${c}`,
  },
  {
    id: "RWA-N6",
    app: "cypress-rwa",
    category: "NO_IMPACT",
    title: "Unrelated comment update in src/components/SkeletonList.tsx",
    targetFile: "src/components/SkeletonList.tsx",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `// EvoBench-48 RWA-N6 unrelated comment\n${c}`,
  },
  {
    id: "HOR-N4",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Unrelated comment update in base/cbv/job_position.py",
    targetFile: "base/cbv/job_position.py",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `# EvoBench-48 HOR-N4 unrelated comment\n${c}`,
  },
  {
    id: "HOR-N5",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Unrelated comment update in base/cbv/job_role.py",
    targetFile: "base/cbv/job_role.py",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `# EvoBench-48 HOR-N5 unrelated comment\n${c}`,
  },
  {
    id: "HOR-N6",
    app: "horilla",
    category: "NO_IMPACT",
    title: "Unrelated template comment in horilla_theme/templates/generic/as_list.html",
    targetFile: "horilla_theme/templates/generic/as_list.html",
    requiresBackendReload: false,
    expectedImpactedSkills: [],
    mutate: (c) => `{# EvoBench-48 HOR-N6 unrelated comment #}\n${c}`,
  },
];

export const EVOBENCH_48: EvoMutationSpec[] = [...EVOBENCH_24, ...EVOBENCH_24_EXTENSION];
