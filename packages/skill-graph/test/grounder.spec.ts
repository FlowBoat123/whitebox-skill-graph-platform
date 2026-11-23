import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { groundSkillCodeRefs } from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RWA_SANDBOX = path.join(REPO_ROOT, "runtime/sandboxes/cypress-realworld-app");
const HORILLA_SANDBOX = path.join(REPO_ROOT, "runtime/sandboxes/horilla");

describe("Static Route-to-Code Grounder (0-LLM)", () => {
  it("statically grounds TypeScript React Router + Express routes and rejects unrelated forms", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grounder-ts-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "demo-ts" }));
      fs.mkdirSync(path.join(tmp, "src/containers"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "src/components"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "backend"), { recursive: true });

      fs.writeFileSync(
        path.join(tmp, "src/containers/AppRoutes.tsx"),
        `import SettingsContainer from "./SettingsContainer";
         import BillingContainer from "./BillingContainer";
         export function AppRoutes() {
           return (
             <Switch>
               <PrivateRoute exact path="/user/settings"><SettingsContainer /></PrivateRoute>
               <PrivateRoute exact path="/billing"><BillingContainer /></PrivateRoute>
             </Switch>
           );
         }`,
      );
      fs.writeFileSync(
        path.join(tmp, "src/containers/SettingsContainer.tsx"),
        `import SettingsForm from "../components/SettingsForm";
         export default function SettingsContainer() { return <SettingsForm />; }`,
      );
      fs.writeFileSync(
        path.join(tmp, "src/components/SettingsForm.tsx"),
        `export default function SettingsForm() { return <input placeholder="First Name" />; }`,
      );
      fs.writeFileSync(
        path.join(tmp, "src/components/UnrelatedSignUpForm.tsx"),
        `export default function UnrelatedSignUpForm() { return <input placeholder="First Name" />; }`,
      );
      fs.writeFileSync(
        path.join(tmp, "backend/app.ts"),
        `import userRoutes from "./user-routes";
         import billingRoutes from "./billing-routes";
         app.use("/users", userRoutes);
         app.use("/billing", billingRoutes);`,
      );
      fs.writeFileSync(path.join(tmp, "backend/user-routes.ts"), `export default {};`);
      fs.writeFileSync(path.join(tmp, "backend/billing-routes.ts"), `export default {};`);

      const res1 = groundSkillCodeRefs({
        repoPath: tmp,
        routes: ["/user/settings"],
        endpoints: ["PATCH /users"],
        uiTerms: ["First Name", "Save"],
      });
      const res2 = groundSkillCodeRefs({
        repoPath: tmp,
        routes: ["/user/settings"],
        endpoints: ["PATCH /users"],
        uiTerms: ["First Name", "Save"],
      });

      expect(res1).toEqual(res2); // Strictly deterministic
      expect(res1.adaptersUsed).toEqual(["TsWebRouteGrounder"]);
      expect(res1.sourceFiles).toContain("backend/user-routes.ts");
      expect(res1.sourceFiles).toContain("src/containers/SettingsContainer.tsx");
      expect(res1.sourceFiles).toContain("src/components/SettingsForm.tsx");
      expect(res1.sourceFiles).not.toContain("src/components/UnrelatedSignUpForm.tsx");
      expect(res1.sourceFiles).not.toContain("backend/billing-routes.ts");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("statically grounds Python Django urls.py -> include() -> CBV -> form_class & theme template", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grounder-dj-"));
    try {
      fs.writeFileSync(path.join(tmp, "manage.py"), "#!/usr/bin/env python\n");
      fs.mkdirSync(path.join(tmp, "myproj"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "hr/cbv"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "assets/cbv"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "custom_theme/templates/generic"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "templates/generic"), { recursive: true });

      fs.writeFileSync(path.join(tmp, "myproj/settings.py"), `ROOT_URLCONF = "myproj.urls"\n`);
      fs.writeFileSync(
        path.join(tmp, "myproj/urls.py"),
        `from django.urls import include, path
urlpatterns = [
    path("", include("hr.urls")),
    path("assets/", include("assets.urls")),
]`,
      );
      fs.writeFileSync(
        path.join(tmp, "hr/urls.py"),
        `from django.urls import path
from hr.cbv import department
urlpatterns = [
    path("dept-create/", department.DepartmentCreateForm.as_view(), name="dept-create"),
]`,
      );
      fs.writeFileSync(
        path.join(tmp, "hr/cbv/department.py"),
        `from hr.forms import DepartmentForm
class DepartmentCreateForm(HorillaFormView):
    form_class = DepartmentForm
    template_name = "generic/form.html"
`,
      );
      fs.writeFileSync(path.join(tmp, "hr/forms.py"), `class DepartmentForm: pass\n`);
      fs.writeFileSync(
        path.join(tmp, "assets/urls.py"),
        `urlpatterns = []\n`,
      );
      fs.writeFileSync(
        path.join(tmp, "assets/cbv/category.py"),
        `# Contains word Save and Create to trick keyword search\n`,
      );
      fs.writeFileSync(
        path.join(tmp, "custom_theme/templates/generic/form.html"),
        `<button>Save</button>`,
      );
      fs.writeFileSync(
        path.join(tmp, "templates/generic/form.html"),
        `<button>Save</button>`,
      );

      const res = groundSkillCodeRefs({
        repoPath: tmp,
        routes: ["/dept-create/"],
        endpoints: ["POST /dept-create/"],
        uiTerms: ["Save", "Create"],
      });

      expect(res.adaptersUsed).toEqual(["DjangoRouteGrounder"]);
      expect(res.sourceFiles).toContain("hr/cbv/department.py");
      expect(res.sourceFiles).toContain("hr/forms.py");
      expect(res.sourceFiles).toContain("custom_theme/templates/generic/form.html");
      expect(res.sourceFiles).not.toContain("assets/cbv/category.py");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("eliminates prior keyword-grep noise when run on real sandboxes (when present)", () => {
    if (fs.existsSync(RWA_SANDBOX)) {
      const rwaUser = groundSkillCodeRefs({
        repoPath: RWA_SANDBOX,
        routes: ["/user/settings"],
        endpoints: ["PATCH /users"],
        uiTerms: ["First Name", "Save"],
      });
      expect(rwaUser.sourceFiles).toContain("src/containers/UserSettingsContainer.tsx");
      expect(rwaUser.sourceFiles).toContain("src/components/UserSettingsForm.tsx");
      expect(rwaUser.sourceFiles).toContain("backend/user-routes.ts");
      expect(rwaUser.sourceFiles).not.toContain("src/components/BankAccountForm.tsx");
      expect(rwaUser.sourceFiles).not.toContain("src/components/SignUpForm.tsx");

      const rwaComment = groundSkillCodeRefs({
        repoPath: RWA_SANDBOX,
        routes: ["/transaction"],
        endpoints: ["POST /comments"],
        uiTerms: ["Write a comment..."],
      });
      expect(rwaComment.sourceFiles).toContain("backend/comment-routes.ts");
      expect(rwaComment.sourceFiles).toContain("src/components/CommentForm.tsx");
      expect(rwaComment.sourceFiles).not.toContain("backend/graphql/resolvers/Mutation.ts");
    }

    if (fs.existsSync(HORILLA_SANDBOX)) {
      const horWorkType = groundSkillCodeRefs({
        repoPath: HORILLA_SANDBOX,
        routes: ["/settings/work-type-view"],
        endpoints: ["POST /work-type-create-form"],
        uiTerms: ["Work Type", "Save"],
      });
      expect(horWorkType.sourceFiles).toContain("base/cbv/work_type_request.py");
      expect(horWorkType.sourceFiles).toContain("base/forms.py");
      expect(horWorkType.sourceFiles).toContain("horilla_theme/templates/generic/form.html");
      expect(horWorkType.sourceFiles.some((f) => f.startsWith("attendance/"))).toBe(false);

      const horDeptDel = groundSkillCodeRefs({
        repoPath: HORILLA_SANDBOX,
        routes: ["/settings/department-view"],
        endpoints: ["POST /generic-delete"],
        fragmentUrls: ["/generic-delete/?model=base.Department&pk=1"],
        uiTerms: ["Delete"],
      });
      expect(horDeptDel.sourceFiles).toContain("base/cbv/department.py");
      expect(horDeptDel.sourceFiles).toContain("horilla_theme/templates/generic/delete_confirmation.html");
      expect(horDeptDel.sourceFiles).not.toContain("templates/no_perm.html");
      expect(horDeptDel.sourceFiles.some((f) => f.startsWith("asset/"))).toBe(false);
    }
  });
});
