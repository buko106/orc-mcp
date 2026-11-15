// git reader: accesses each repository read-only. Never goes through a shell (execFile).
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]*$/;

export class GitError extends Error {}

export function assertRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.includes("..")) throw new GitError(`invalid git ref: ${ref}`);
  return ref;
}

export function assertRelPath(p: string): string {
  if (p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..") || p.includes("\0")) {
    throw new GitError(`invalid path: ${p}`);
  }
  return p;
}

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repo, "--no-pager", ...args],
      { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(stderr.trim() || err.message));
        else resolve(stdout);
      },
    );
  });
}

export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function repoRoot(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
}

/**
 * Name of the main repository. Even when called from inside a worktree, returns the main repository's name, not the worktree's directory name.
 * (worktrees share the .git directory, so the name is derived from its location)
 */
export async function repoName(path: string): Promise<string> {
  const common = (await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  return basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
}

/** Name of the checked-out branch. null for a detached HEAD. */
export async function currentBranch(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || null;
  } catch {
    return null;
  }
}

export async function headSha(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null; // repository with no commits yet
  }
}

/** Returns the full SHA if the commit exists, otherwise null. */
export async function resolveCommit(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ["rev-parse", "--verify", "--quiet", `${assertRef(ref)}^{commit}`])).trim() || null;
  } catch (e) {
    if (e instanceof GitError && e.message.startsWith("invalid git ref")) throw e;
    return null;
  }
}

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files: { status: string; path: string }[];
}

/** Commits from since (exclusive) to HEAD. Without since, the latest `limit` commits. */
export async function log(repo: string, since: string | null, limit: number): Promise<CommitInfo[]> {
  const args = ["log", "--no-color", "--date=iso-strict", "--pretty=format:%x1e%H%x1f%an%x1f%ad%x1f%s", "--name-status", "-n", String(limit)];
  if (since) args.push(`${assertRef(since)}..HEAD`);
  args.push("--");
  const out = await git(repo, args);
  return out
    .split("\x1e")
    .filter((s) => s.trim() !== "")
    .map((rec) => {
      const [head = "", ...rest] = rec.split("\n");
      const [sha = "", author = "", date = "", subject = ""] = head.split("\x1f");
      const files = rest
        .filter((l) => l.trim() !== "")
        .map((l) => {
          const [status = "", ...p] = l.split("\t");
          return { status, path: p.join(" -> ") };
        });
      return { sha, author, date, subject, files };
    });
}

export async function diff(repo: string, from: string, to: string, path: string | undefined, statOnly: boolean): Promise<string> {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (statOnly) args.push("--stat");
  args.push(assertRef(from), assertRef(to), "--");
  if (path) args.push(assertRelPath(path));
  return git(repo, args);
}

export async function showFile(repo: string, ref: string, path: string): Promise<string> {
  return git(repo, ["show", "--no-color", `${assertRef(ref)}:${assertRelPath(path)}`]);
}
