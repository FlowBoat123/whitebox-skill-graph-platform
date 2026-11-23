import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "..");
const repositoryRoot = resolve(packageDirectory, "../..");
const fixturesDirectory = join(testDirectory, "fixtures");

export interface MaterializedFixture {
  root: string;
  dispose: () => Promise<void>;
}

/**
 * Negative fixtures are overlays on top of valid-registry. This keeps every
 * scenario focused on the one value that makes it invalid while still giving
 * the validator a complete registry and its local schemas.
 */
export async function materializeFixture(
  name: string,
): Promise<MaterializedFixture> {
  const root = await mkdtemp(join(tmpdir(), "knowledge-registry-test-"));

  await cp(
    join(fixturesDirectory, "valid-registry", "knowledge"),
    join(root, "knowledge"),
    { recursive: true },
  );
  await cp(join(repositoryRoot, "contracts"), join(root, "contracts"), {
    recursive: true,
  });

  if (name !== "valid-registry") {
    await cp(join(fixturesDirectory, name, "knowledge"), join(root, "knowledge"), {
      recursive: true,
      force: true,
    });
  }

  return {
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function diagnosticsText(errors: ReadonlyArray<unknown>): string {
  return JSON.stringify(errors);
}

