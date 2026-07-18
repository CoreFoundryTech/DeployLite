import { relative, resolve } from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const inside = (parent, child) => { const path = relative(parent, child); return path === "" || (!path.startsWith("..") && !path.includes("../")); };

export function assertExecutionBinding(binding, expected) {
  if (!binding || !SHA.test(binding.headSha)) throw new TypeError("exact head SHA is required");
  if (binding.repository !== expected.repository) throw new TypeError("repository mismatch");
  if (binding.authenticatedLogin !== expected.authenticatedLogin) throw new TypeError("account mismatch");
}

export async function createDetachedWorktree({ binding, controllerRoot, worktreeParent, git, makePath }) {
  const controller = resolve(controllerRoot);
  const parent = resolve(worktreeParent);
  if (inside(controller, parent)) throw new TypeError("worktree parent must be outside controller checkout");
  const path = makePath ? makePath() : `${parent}/local-ci-evidence-${binding.headSha.slice(0, 12)}`;
  if (!inside(parent, resolve(path))) throw new TypeError("worktree path escapes its parent");
  await git(["-C", controller, "fetch", "--no-tags", "origin", binding.headSha]);
  await git(["-C", controller, "cat-file", "-e", `${binding.headSha}^{commit}`]);
  await git(["-C", controller, "worktree", "add", "--detach", "--force", path, binding.headSha]);
  if ((await git(["-C", path, "rev-parse", "HEAD"])).trim() !== binding.headSha) throw new TypeError("worktree SHA mismatch");
  return Object.freeze({ path, sha: binding.headSha });
}

export async function removeDetachedWorktree({ controllerRoot, path, git }) {
  await git(["-C", resolve(controllerRoot), "worktree", "remove", "--force", path]);
}
