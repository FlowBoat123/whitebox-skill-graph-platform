import fs from "node:fs";
import path from "node:path";

export interface GroundingInput {
  repoPath: string;
  routes: string[];
  endpoints: string[];
  /** Optional raw observed fragment/HTMX paths (may include query params like ?model=app.Model). */
  fragmentUrls?: string[];
  /** Optional visible UI terms interacted with during authoring (placeholders, button labels). */
  uiTerms?: string[];
  maxFiles?: number;
}

export type GroundingStrategy =
  | "STATIC_TS_ROUTER"
  | "STATIC_TS_COMPONENT_HOP"
  | "STATIC_EXPRESS_ROUTE"
  | "STATIC_GRAPHQL_RESOLVER"
  | "STATIC_DJANGO_URL"
  | "STATIC_DJANGO_VIEW_REF"
  | "STATIC_DJANGO_MODEL_REF"
  | "TOKEN_FALLBACK";

export interface GroundedSourceFile {
  file: string;
  strategy: GroundingStrategy;
  matchedBy: string;
  score: number;
}

export interface GroundingResult {
  adaptersUsed: string[];
  sourceFiles: string[];
  evidence: GroundedSourceFile[];
}

export interface RouteGrounderAdapter {
  readonly name: string;
  detect(repoPath: string): boolean;
  ground(input: GroundingInput): GroundedSourceFile[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "cypress",
  "__pycache__",
  ".venv",
  "venv",
  "static",
  "staticfiles",
  "migrations",
  ".next",
]);

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function walkFiles(
  repoPath: string,
  extRegex: RegExp,
  excludeRegex = /\.cy\.|\.spec\.|\.test\.|__tests__/i,
): string[] {
  if (!fs.existsSync(repoPath)) return [];
  const results: string[] = [];
  const visit = (dir: string, relBase: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(full, rel);
      } else if (entry.isFile() && extRegex.test(entry.name) && !excludeRegex.test(rel)) {
        results.push(rel);
      }
    }
  };
  visit(repoPath, "");
  return results;
}

function extractPathFromEndpoint(ep: string): string {
  const parts = ep.trim().split(/\s+/);
  const raw = parts.length >= 2 ? parts[1]! : parts[0]!;
  return raw.split("?")[0] ?? "/";
}

function normalizeUrlPath(raw: string): string {
  const withoutQuery = raw.split("?")[0] ?? "/";
  const withLead = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withLead.length > 1 ? withLead.replace(/\/+$/, "") : "/";
}

function resolveRelativeTsFile(repoPath: string, fromFileRel: string, importSpec: string): string | null {
  if (!importSpec.startsWith(".")) return null;
  const baseDir = path.dirname(path.join(repoPath, fromFileRel));
  const rawTarget = path.resolve(baseDir, importSpec);
  const candidates = [
    rawTarget,
    `${rawTarget}.tsx`,
    `${rawTarget}.ts`,
    `${rawTarget}.jsx`,
    `${rawTarget}.js`,
    path.join(rawTarget, "index.tsx"),
    path.join(rawTarget, "index.ts"),
    path.join(rawTarget, "index.jsx"),
    path.join(rawTarget, "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      const rel = normRel(path.relative(repoPath, c));
      if (!rel.startsWith("..")) return rel;
    }
  }
  return null;
}

function parseTsImports(content: string): Map<string, string> {
  const map = new Map<string, string>();
  // Default import: import Foo from "./Foo"
  for (const m of content.matchAll(/import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+["']([^"']+)["']/g)) {
    if (m[1] && m[2]) map.set(m[1], m[2]);
  }
  // Named imports: import { A, B as C } from "./mod"
  for (const m of content.matchAll(/import\s*\{([^}]+)\}\s*from\s+["']([^"']+)["']/g)) {
    const spec = m[2];
    if (!m[1] || !spec) continue;
    for (const part of m[1].split(",")) {
      const cleaned = part.trim();
      const alias = cleaned.split(/\s+as\s+/);
      const localName = (alias[1] ?? alias[0])?.trim();
      if (localName) map.set(localName, spec);
    }
  }
  return map;
}

function matchReactRoutePattern(pattern: string, observedPath: string): boolean {
  const normObs = normalizeUrlPath(observedPath);
  const normPat = normalizeUrlPath(pattern);
  if (normPat === normObs) return true;
  if (normPat === "/" && normObs === "/") return true;
  if (normPat.endsWith("*")) {
    const prefix = normalizeUrlPath(normPat.slice(0, -1));
    if (normObs === prefix || normObs.startsWith(`${prefix}/`)) return true;
  }
  // Handle React Router regex group like "/(public|contacts|personal)?"
  if (normPat.includes("(") && normPat.includes("|")) {
    try {
      const re = new RegExp(`^${normPat}$`);
      if (re.test(normObs)) return true;
    } catch {
      // ignore invalid regex
    }
  }
  // Handle :param segments (e.g. /transaction/:transactionId matching /transaction or /transaction/123)
  const patSegs = normPat.split("/").filter(Boolean);
  const obsSegs = normObs.split("/").filter(Boolean);
  if (patSegs.length === obsSegs.length && patSegs.length > 0) {
    return patSegs.every((seg, i) => seg.startsWith(":") || seg === obsSegs[i]);
  }
  // Also allow observed normalized base route /transaction matching /transaction/:id
  if (
    patSegs.length === obsSegs.length + 1 &&
    patSegs.at(-1)?.startsWith(":") &&
    obsSegs.every((seg, i) => patSegs[i] === seg)
  ) {
    return true;
  }
  return false;
}

/**
 * Stack Adapter 1: Static TypeScript / React Router / Express / GraphQL Grounder.
 * Traces observed frontend routes through <Route>/<PrivateRoute> JSX declarations
 * and 1-2 hop component imports, and traces observed API endpoints through Express
 * app.use() mounts and GraphQL resolver modules.
 */
export class TsWebRouteGrounder implements RouteGrounderAdapter {
  readonly name = "TsWebRouteGrounder";

  detect(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "package.json"));
  }

  ground(input: GroundingInput): GroundedSourceFile[] {
    const hits: GroundedSourceFile[] = [];
    const tsFiles = walkFiles(input.repoPath, /\.(tsx?|jsx?)$/i);
    const uiTerms = (input.uiTerms ?? []).map((t) => t.trim()).filter((t) => t.length >= 3);
    const observedRoutes = input.routes.map(normalizeUrlPath).filter((r) => r.length > 0);
    const observedEndpointPaths = input.endpoints.map((ep) => normalizeUrlPath(extractPathFromEndpoint(ep)));

    // 1. Express backend route mounting: app.use("/prefix", routerVar)
    for (const rel of tsFiles) {
      if (!/^(backend|server|api)\//i.test(rel)) continue;
      const content = fs.readFileSync(path.join(input.repoPath, rel), "utf8");
      if (!content.includes(".use(")) continue;
      const imports = parseTsImports(content);

      for (const m of content.matchAll(
        /\bapp\.use\(\s*["']([^"']+)["']\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
      )) {
        const mountPath = normalizeUrlPath(m[1]!);
        const handlerSym = m[2]!;
        const matchesEndpoint = observedEndpointPaths.some(
          (ep) => ep === mountPath || ep.startsWith(`${mountPath}/`),
        );
        if (!matchesEndpoint) continue;

        if (mountPath === "/graphql") {
          // Trace GraphQL resolvers imported in backend/app.ts
          const resolverSpec = imports.get("resolvers");
          const resolverEntry = resolverSpec ? resolveRelativeTsFile(input.repoPath, rel, resolverSpec) : null;
          if (resolverEntry) {
            const rContent = fs.readFileSync(path.join(input.repoPath, resolverEntry), "utf8");
            const rImports = parseTsImports(rContent);
            const mutSpec = rImports.get("Mutation");
            const mutFile = mutSpec ? resolveRelativeTsFile(input.repoPath, resolverEntry, mutSpec) : null;
            if (mutFile) {
              hits.push({
                file: mutFile,
                strategy: "STATIC_GRAPHQL_RESOLVER",
                matchedBy: `POST /graphql -> Mutation`,
                score: 12,
              });
            }
          }
          continue;
        }

        const modSpec = imports.get(handlerSym);
        const resolved = modSpec ? resolveRelativeTsFile(input.repoPath, rel, modSpec) : null;
        if (resolved) {
          hits.push({
            file: resolved,
            strategy: "STATIC_EXPRESS_ROUTE",
            matchedBy: `app.use("${mountPath}", ${handlerSym})`,
            score: 14,
          });
        }
      }
    }

    // 2. React Router frontend tracing: <Route path="..."> / <PrivateRoute path="...">
    const containerQueue: Array<{ file: string; matchedRoute: string; depth: number }> = [];
    const visitedContainers = new Set<string>();

    for (const rel of tsFiles) {
      if (!/^src\//i.test(rel)) continue;
      const content = fs.readFileSync(path.join(input.repoPath, rel), "utf8");
      if (!/<[A-Za-z]*Route\b/.test(content)) continue;
      const imports = parseTsImports(content);

      // Match JSX Route/PrivateRoute blocks containing a child component tag
      const routeBlockRe =
        /<(?:Private)?Route\b[^>]*\bpath=\{?["']([^"']+)["']\}?[^>]*>([\s\S]*?)<\/(?:Private)?Route>/g;
      for (const m of content.matchAll(routeBlockRe)) {
        const routePat = m[1]!;
        const innerJsx = m[2]!;
        const matchedRoute = observedRoutes.find((r) => matchReactRoutePattern(routePat, r));
        if (!matchedRoute) continue;

        for (const compMatch of innerJsx.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)) {
          const compName = compMatch[1]!;
          const spec = imports.get(compName);
          const resolved = spec ? resolveRelativeTsFile(input.repoPath, rel, spec) : null;
          if (resolved && !visitedContainers.has(resolved)) {
            visitedContainers.add(resolved);
            // Prioritize specific non-root routes higher than catch-all "/"
            const specificity = routePat === "/" || routePat.includes("|") ? 7 : 12;
            hits.push({
              file: resolved,
              strategy: "STATIC_TS_ROUTER",
              matchedBy: `<Route path="${routePat}"> -> ${compName}`,
              score: specificity,
            });
            containerQueue.push({ file: resolved, matchedRoute, depth: 0 });
          }
        }
      }

      // Also handle self-closing <Route path="/signin" component={SignInForm} />
      const selfCloseRe =
        /<(?:Private)?Route\b[^>]*\bpath=\{?["']([^"']+)["']\}?[^>]*\bcomponent=\{([A-Z][A-Za-z0-9_]*)\}/g;
      for (const m of content.matchAll(selfCloseRe)) {
        const routePat = m[1]!;
        const compName = m[2]!;
        const matchedRoute = observedRoutes.find((r) => matchReactRoutePattern(routePat, r));
        if (!matchedRoute) continue;
        const spec = imports.get(compName);
        const resolved = spec ? resolveRelativeTsFile(input.repoPath, rel, spec) : null;
        if (resolved && !visitedContainers.has(resolved)) {
          visitedContainers.add(resolved);
          hits.push({
            file: resolved,
            strategy: "STATIC_TS_ROUTER",
            matchedBy: `<Route path="${routePat}" component={${compName}}>`,
            score: 12,
          });
          containerQueue.push({ file: resolved, matchedRoute, depth: 0 });
        }
      }
    }

    // Follow up to 2 hops of child UI component imports from matched route containers
    while (containerQueue.length > 0) {
      const curr = containerQueue.shift()!;
      if (curr.depth >= 2) continue;
      const content = fs.readFileSync(path.join(input.repoPath, curr.file), "utf8");
      const imports = parseTsImports(content);

      for (const [sym, spec] of imports.entries()) {
        if (!/^[A-Z]/.test(sym) || /Illustration|Svg|Logo|Icon/i.test(sym)) continue;
        const childFile = resolveRelativeTsFile(input.repoPath, curr.file, spec);
        if (!childFile || !/components\//i.test(childFile) || visitedContainers.has(childFile)) {
          continue;
        }
        const childContent = fs.readFileSync(path.join(input.repoPath, childFile), "utf8");
        const matchedTerm = uiTerms.find((t) => childContent.includes(t));
        const isFormOrDetail = /Form|Detail|Item|List|Tabs/i.test(path.basename(childFile));
        if (matchedTerm || (curr.depth === 0 && isFormOrDetail)) {
          visitedContainers.add(childFile);
          hits.push({
            file: childFile,
            strategy: "STATIC_TS_COMPONENT_HOP",
            matchedBy: matchedTerm
              ? `${path.basename(curr.file)} -> ${sym} (UI term "${matchedTerm}")`
              : `${path.basename(curr.file)} -> ${sym}`,
            score: matchedTerm ? 15 : 9 - curr.depth,
          });
          containerQueue.push({ file: childFile, matchedRoute: curr.matchedRoute, depth: curr.depth + 1 });
        }
      }
    }

    return hits;
  }
}

interface DjangoUrlEntry {
  fullPattern: string;
  urlFile: string;
  handlerExpr: string;
  resolvedFile?: string;
  symbolName?: string;
}

function parsePythonImports(content: string): Map<string, string> {
  const map = new Map<string, string>();
  // Single-line: from a.b import c, d as e
  for (const m of content.matchAll(/from\s+([a-zA-Z0-9_.]+)\s+import\s+([^\n(#]+)/g)) {
    const mod = m[1]!;
    for (const part of m[2]!.split(",")) {
      const segs = part.trim().split(/\s+as\s+/);
      const orig = segs[0]?.trim();
      const local = (segs[1] ?? orig)?.trim();
      if (local && orig) {
        map.set(local, `${mod}.${orig}`);
      }
    }
  }
  // Multi-line parenthesized: from a.b import (\n c, d\n)
  for (const m of content.matchAll(/from\s+([a-zA-Z0-9_.]+)\s+import\s*\(([\s\S]*?)\)/g)) {
    const mod = m[1]!;
    for (const part of m[2]!.split(",")) {
      const noComment = part.replace(/#.*$/, "").trim();
      if (!noComment) continue;
      const segs = noComment.split(/\s+as\s+/);
      const orig = segs[0]?.trim();
      const local = (segs[1] ?? orig)?.trim();
      if (local && orig) {
        map.set(local, `${mod}.${orig}`);
      }
    }
  }
  // Direct: import a.b as c
  for (const m of content.matchAll(/^import\s+([a-zA-Z0-9_.]+)(?:\s+as\s+([a-zA-Z0-9_]+))?/gm)) {
    const mod = m[1]!;
    const local = m[2] ?? mod.split(".")[0]!;
    map.set(local, mod);
  }
  return map;
}

function resolvePythonModulePath(repoPath: string, dotted: string): { file: string; symbol?: string } | null {
  const parts = dotted.split(".").filter(Boolean);
  for (let len = parts.length; len >= 1; len--) {
    const modRel = `${parts.slice(0, len).join("/")}.py`;
    if (fs.existsSync(path.join(repoPath, modRel))) {
      const sym = parts.slice(len).join(".");
      return sym ? { file: modRel, symbol: sym } : { file: modRel };
    }
    const pkgInit = `${parts.slice(0, len).join("/")}/__init__.py`;
    if (fs.existsSync(path.join(repoPath, pkgInit))) {
      const sym = parts.slice(len).join(".");
      return sym ? { file: pkgInit, symbol: sym } : { file: pkgInit };
    }
  }
  return null;
}

function matchDjangoUrlPattern(djangoPattern: string, observedPath: string): boolean {
  const normPat = normalizeUrlPath(djangoPattern.replace(/^\^/, "").replace(/\$$/, ""));
  const normObs = normalizeUrlPath(observedPath);
  if (normPat === normObs) return true;
  const patSegs = normPat.split("/").filter(Boolean);
  const obsSegs = normObs.split("/").filter(Boolean);
  if (patSegs.length !== obsSegs.length) return false;
  return patSegs.every(
    (seg, idx) =>
      (/^<[^>]+>$/.test(seg) && obsSegs[idx]!.length > 0) || seg === obsSegs[idx],
  );
}

function resolveDjangoTemplate(repoPath: string, templateRel: string): string | null {
  const clean = templateRel.replace(/^\/+/, "");
  const roots = [
    ...fs
      .readdirSync(repoPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /theme/i.test(d.name))
      .map((d) => path.join(d.name, "templates"))
      .sort(),
    "templates",
  ];
  // Check theme templates first, then project templates, then app templates
  for (const r of roots) {
    const cand = normRel(path.join(r, clean));
    if (fs.existsSync(path.join(repoPath, cand))) return cand;
  }
  for (const entry of fs.readdirSync(repoPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const cand = normRel(path.join(entry.name, "templates", clean));
    if (fs.existsSync(path.join(repoPath, cand))) return cand;
  }
  return null;
}

/**
 * Stack Adapter 2: Static Python / Django Route-to-Code Grounder.
 * Recursively parses urlpatterns (path / re_path / include), resolves observed
 * URLs & HTMX fragment routes to their exact View/CBV Python files, then follows
 * 1-hop references to form_class, template_name, render(), and ?model=app.Model targets.
 */
export class DjangoRouteGrounder implements RouteGrounderAdapter {
  readonly name = "DjangoRouteGrounder";

  detect(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, "manage.py"));
  }

  private buildUrlTable(repoPath: string): DjangoUrlEntry[] {
    const entries: DjangoUrlEntry[] = [];
    const visitedUrlFiles = new Set<string>();

    // Find root urls.py (prefer ROOT_URLCONF from settings.py, else top-level <dir>/urls.py)
    const rootCandidates: string[] = [];
    for (const d of fs.readdirSync(repoPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      const settingsPath = path.join(repoPath, d.name, "settings.py");
      if (fs.existsSync(settingsPath)) {
        const sContent = fs.readFileSync(settingsPath, "utf8");
        const m = /ROOT_URLCONF\s*=\s*["']([^"']+)["']/.exec(sContent);
        if (m?.[1]) {
          const resolved = resolvePythonModulePath(repoPath, m[1]);
          if (resolved) rootCandidates.push(resolved.file);
        }
      }
    }
    if (rootCandidates.length === 0) {
      for (const f of walkFiles(repoPath, /^urls\.py$/i)) {
        rootCandidates.push(f);
      }
    }

    const parseUrlFile = (urlFileRel: string, prefix: string) => {
      const key = `${prefix}::${urlFileRel}`;
      if (visitedUrlFiles.has(key)) return;
      visitedUrlFiles.add(key);
      const fullPath = path.join(repoPath, urlFileRel);
      if (!fs.existsSync(fullPath)) return;
      const content = fs.readFileSync(fullPath, "utf8");
      const imports = parsePythonImports(content);

      // 1. Follow include("app.urls")
      for (const m of content.matchAll(
        /(?:re_)?path\(\s*["']([^"']*)["']\s*,\s*include\(\s*["']([a-zA-Z0-9_.]+)["']/g,
      )) {
        const seg = m[1]!.replace(/^\^/, "");
        const incMod = m[2]!;
        const resolved = resolvePythonModulePath(repoPath, incMod);
        if (resolved) {
          const joinedPrefix = `${prefix.replace(/\/$/, "")}/${seg.replace(/^\//, "")}`;
          parseUrlFile(resolved.file, joinedPrefix);
        }
      }

      // 2. Direct view/CBV bindings: path("route/", view.Class.as_view(), ...) or path("route/", views.func, ...)
      for (const m of content.matchAll(
        /(?:re_)?path\(\s*["']([^"']+)["']\s*,\s*([a-zA-Z_][a-zA-Z0-9_.]*)(?:\.as_view\(\))?/g,
      )) {
        const seg = m[1]!;
        const handlerExpr = m[2]!;
        if (handlerExpr === "include" || handlerExpr === "RedirectView") continue;
        const fullPattern = normalizeUrlPath(
          `${prefix.replace(/\/$/, "")}/${seg.replace(/^\^/, "").replace(/^\//, "")}`,
        );
        const parts = handlerExpr.split(".");
        const head = parts[0]!;
        const importedDotted = imports.get(head);
        const fullDotted = importedDotted
          ? [importedDotted, ...parts.slice(1)].join(".")
          : handlerExpr;
        const resolved = resolvePythonModulePath(repoPath, fullDotted);
        entries.push({
          fullPattern,
          urlFile: urlFileRel,
          handlerExpr,
          ...(resolved ? { resolvedFile: resolved.file } : {}),
          ...(resolved?.symbol ? { symbolName: resolved.symbol } : parts.at(-1) ? { symbolName: parts.at(-1)! } : {}),
        });
      }
    };

    for (const root of rootCandidates) {
      parseUrlFile(root, "");
    }
    return entries;
  }

  ground(input: GroundingInput): GroundedSourceFile[] {
    const hits: GroundedSourceFile[] = [];
    const table = this.buildUrlTable(input.repoPath);

    const candidatePaths = new Set<string>();
    for (const r of input.routes) candidatePaths.add(normalizeUrlPath(r));
    for (const ep of input.endpoints) candidatePaths.add(normalizeUrlPath(extractPathFromEndpoint(ep)));
    for (const frag of input.fragmentUrls ?? []) candidatePaths.add(normalizeUrlPath(frag));

    // Also inspect ?model=<app>.<Model> query params on generic HTMX endpoints (e.g. /generic-delete/?model=base.Department)
    for (const raw of [...input.endpoints, ...(input.fragmentUrls ?? [])]) {
      const modelMatch = /[?&]model=([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/.exec(raw);
      if (modelMatch?.[1] && modelMatch[2]) {
        const appName = modelMatch[1].toLowerCase();
        const modelName = modelMatch[2].toLowerCase();
        const snake = modelName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        const cbvDir = path.join(input.repoPath, appName, "cbv");
        if (fs.existsSync(cbvDir)) {
          for (const f of fs.readdirSync(cbvDir).sort()) {
            const stem = f.replace(/\.py$/i, "").replace(/_/g, "").toLowerCase();
            if (stem === modelName || f.toLowerCase() === `${snake}.py`) {
              hits.push({
                file: normRel(path.join(appName, "cbv", f)),
                strategy: "STATIC_DJANGO_MODEL_REF",
                matchedBy: `query model=${modelMatch[1]}.${modelMatch[2]}`,
                score: 14,
              });
            }
          }
        }
      }
    }

    const matchedEntries: DjangoUrlEntry[] = [];
    for (const obsPath of candidatePaths) {
      if (obsPath === "/") continue;
      for (const entry of table) {
        if (matchDjangoUrlPattern(entry.fullPattern, obsPath)) {
          matchedEntries.push(entry);
        }
      }
    }

    // 1-hop inspect each matched view/CBV file for form_class, template_name, render(), and generic base templates
    for (const entry of matchedEntries) {
      if (!entry.resolvedFile) continue;
      const isSettingsOrForm = /create|form|delete|login|department|work_type|employee_type/i.test(
        entry.fullPattern,
      );
      hits.push({
        file: entry.resolvedFile,
        strategy: "STATIC_DJANGO_URL",
        matchedBy: `${entry.fullPattern} -> ${entry.handlerExpr}`,
        score: isSettingsOrForm ? 14 : 11,
      });

      const viewAbs = path.join(input.repoPath, entry.resolvedFile);
      if (!fs.existsSync(viewAbs)) continue;
      const content = fs.readFileSync(viewAbs, "utf8");
      const imports = parsePythonImports(content);

      // Extract the specific class or function block (plus 1-hop local superclass inheritance)
      // when symbolName is known so we don't grab unrelated symbols in large views.py!
      let scopedSnippet = content;
      const targetSym = entry.symbolName?.replace(/\.as_view$/, "").split(".")[0];
      const extractClassBlock = (clsName: string): string | null => {
        const re = new RegExp(
          `^class\\s+${clsName}\\b[\\s\\S]*?(?=^class\\s+|^def\\s+|(?![\\s\\S]))`,
          "m",
        );
        return re.exec(content)?.[0] ?? null;
      };
      if (targetSym) {
        const clsBody = extractClassBlock(targetSym);
        const defRe = new RegExp(
          `^def\\s+${targetSym}\\b[\\s\\S]*?(?=^class\\s+|^def\\s+|(?![\\s\\S]))`,
          "m",
        );
        const defBody = defRe.exec(content)?.[0] ?? null;
        if (clsBody) {
          scopedSnippet = clsBody;
          // Follow up to 2 hops of same-file base class inheritance (e.g. class Child(Parent):)
          const visitedBases = new Set<string>([targetSym]);
          const queue = [clsBody];
          while (queue.length > 0 && visitedBases.size <= 4) {
            const cur = queue.shift()!;
            const headerMatch = /^class\s+[A-Za-z_][A-Za-z0-9_]*\(([^)]+)\)/m.exec(cur);
            if (!headerMatch?.[1]) continue;
            for (const rawBase of headerMatch[1].split(",")) {
              const baseName = rawBase.trim().split(".").at(-1);
              if (!baseName || visitedBases.has(baseName)) continue;
              visitedBases.add(baseName);
              const baseBody = extractClassBlock(baseName);
              if (baseBody) {
                scopedSnippet += `\n${baseBody}`;
                queue.push(baseBody);
              }
            }
          }
        } else if (defBody) {
          scopedSnippet = defBody;
        }
      }

      // Trace form_class = SomeForm
      for (const fm of scopedSnippet.matchAll(/form_class\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const formSym = fm[1]!;
        const dotted = imports.get(formSym);
        const resolved = dotted ? resolvePythonModulePath(input.repoPath, dotted) : null;
        if (resolved) {
          hits.push({
            file: resolved.file,
            strategy: "STATIC_DJANGO_VIEW_REF",
            matchedBy: `${entry.symbolName ?? entry.resolvedFile}.form_class = ${formSym}`,
            score: 12,
          });
        }
      }

      // Trace explicit template_name = "..." or render(request, "...")
      const tplRefs = new Set<string>();
      for (const tm of scopedSnippet.matchAll(/template_name\s*=\s*["']([^"']+\.html)["']/g)) {
        if (tm[1]) tplRefs.add(tm[1]);
      }
      for (const rm of scopedSnippet.matchAll(/render\(\s*[^,]+,\s*["']([^"']+\.html)["']/g)) {
        if (rm[1]) tplRefs.add(rm[1]);
      }
      // Trace standard CBV form/delete base-class templates when inherited without overriding template_name
      if (/\(\s*HorillaFormView\s*\)/.test(scopedSnippet)) {
        tplRefs.add("generic/form.html");
      }
      if (/\(\s*HorillaNavView\s*\)/.test(scopedSnippet)) {
        tplRefs.add("generic/horilla_nav.html");
      }
      if (/DeleteConfirmation/i.test(entry.symbolName ?? "")) {
        tplRefs.add("generic/delete_confirmation.html");
      }

      const ERROR_FALLBACK_TEMPLATE_RE =
        /(?:^|\/)(?:400|403|404|500|no_perm|permission_denied|error)\.html$/i;
      for (const tpl of tplRefs) {
        if (ERROR_FALLBACK_TEMPLATE_RE.test(tpl)) continue;
        const resolvedTpl = resolveDjangoTemplate(input.repoPath, tpl);
        if (resolvedTpl) {
          hits.push({
            file: resolvedTpl,
            strategy: "STATIC_DJANGO_VIEW_REF",
            matchedBy: `${entry.symbolName ?? entry.resolvedFile} -> template ${tpl}`,
            score: 13,
          });
        }
      }
    }

    return hits;
  }
}

function tokenFallbackGround(input: GroundingInput): GroundedSourceFile[] {
  const candidates = walkFiles(input.repoPath, /\.(tsx?|jsx?|py|html)$/i);
  const tokens = new Set<string>();
  for (const ep of input.endpoints) {
    const p = extractPathFromEndpoint(ep);
    for (const seg of p.split("/").filter(Boolean)) {
      if (seg.length >= 3 && !/^\d+$/.test(seg)) tokens.add(seg.toLowerCase());
    }
  }
  for (const term of input.uiTerms ?? []) {
    const clean = term.trim();
    if (clean.length >= 4 && clean.length <= 40) tokens.add(clean);
  }
  const hits: GroundedSourceFile[] = [];
  for (const rel of candidates) {
    const content = fs.readFileSync(path.join(input.repoPath, rel), "utf8");
    const lowerRel = rel.toLowerCase();
    let score = 0;
    let matched = "";
    for (const tok of tokens) {
      if (tok === tok.toLowerCase()) {
        if (lowerRel.includes(tok) || lowerRel.includes(tok.replace(/s$/, ""))) {
          score += 3;
          matched = matched || `path:${tok}`;
        }
      } else if (content.includes(tok)) {
        score += 4;
        matched = matched || `term:${tok}`;
      }
    }
    if (score >= 3) {
      hits.push({ file: rel, strategy: "TOKEN_FALLBACK", matchedBy: matched, score });
    }
  }
  return hits;
}

const DEFAULT_ADAPTERS: RouteGrounderAdapter[] = [
  new DjangoRouteGrounder(),
  new TsWebRouteGrounder(),
];

export function groundSkillCodeRefs(
  input: GroundingInput,
  adapters: RouteGrounderAdapter[] = DEFAULT_ADAPTERS,
): GroundingResult {
  if (!fs.existsSync(input.repoPath)) {
    return { adaptersUsed: [], sourceFiles: [], evidence: [] };
  }

  const maxFiles = input.maxFiles ?? 6;
  const adaptersUsed: string[] = [];
  const rawHits: GroundedSourceFile[] = [];

  for (const adapter of adapters) {
    if (adapter.detect(input.repoPath)) {
      adaptersUsed.push(adapter.name);
      rawHits.push(...adapter.ground(input));
    }
  }

  if (rawHits.length === 0) {
    adaptersUsed.push("TokenFallbackGrounder");
    rawHits.push(...tokenFallbackGround(input));
  }

  // Deduplicate by file, keeping highest score & merging matchedBy deterministically
  const byFile = new Map<string, GroundedSourceFile>();
  for (const h of rawHits) {
    const prev = byFile.get(h.file);
    if (!prev || h.score > prev.score || (h.score === prev.score && h.matchedBy < prev.matchedBy)) {
      byFile.set(h.file, h);
    }
  }

  const ranked = [...byFile.values()].sort(
    (a, b) => b.score - a.score || a.file.localeCompare(b.file),
  );
  const top = ranked.slice(0, maxFiles);
  return {
    adaptersUsed,
    sourceFiles: top.map((t) => t.file),
    evidence: top,
  };
}
