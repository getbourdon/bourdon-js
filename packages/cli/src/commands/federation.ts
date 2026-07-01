/**
 * Federation trust-management + audit commands — `agent {add,list,rotate,
 * set-tier}`, `grant`, `ungrant`, `revoke`, `staging {list,promote,reject}`,
 * `audit`. All backed by the ported @getbourdon/federation registry / staging /
 * audit primitives.
 */

import {
  type AuditEntry,
  DEFAULT_LIBRARY_PATH,
  FederationAudit,
  FederationRegistry,
  RegistryError,
  listStaged,
  promote,
  reject,
} from "@getbourdon/federation";
import { discoverParticipants } from "@getbourdon/participants";

import type { Dict } from "../util.js";

/** Whether a discovered participant declares itself quarantined-class (e.g.
 * OpenClaw, the network-shaped reader in @getbourdon/participants). Read from
 * the `quarantinedClass` contract marker rather than hard-coded. */
function isQuarantinedClass(agentId: string): boolean {
  for (const p of discoverParticipants()) {
    if (p.agentId === agentId && p.quarantinedClass === true) {
      return true;
    }
  }
  return false;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function handleAgentAdd(opts: Dict, args: string[]): number {
  const agentId = String(args[0] ?? "");
  const tier = String(opts.tier ?? "quarantined");
  if (tier === "trusted" && isQuarantinedClass(agentId) && !opts.iUnderstandTheRisk) {
    process.stderr.write(
      `refusing: ${JSON.stringify(agentId)} is a quarantined-class agent. ` +
        "Registering it as trusted exposes the full federation to it. " +
        "Re-run with --i-understand-the-risk to override.\n",
    );
    return 1;
  }
  const registry = new FederationRegistry();
  let token: string;
  try {
    token = registry.addAgent(agentId, tier, (opts.grant as string[]) ?? []);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(`registered ${agentId} (tier: ${tier})\n`);
  process.stdout.write(`token: ${token}\n`);
  process.stderr.write(
    "This token is shown ONCE and stored only as a hash. " +
      "Pass it as `Authorization: Bearer <token>` on the HTTP transport.\n",
  );
  return 0;
}

export function handleAgentList(_opts: Dict, _args: string[]): number {
  const rows = new FederationRegistry().listAgents();
  const ids = Object.keys(rows);
  if (ids.length === 0) {
    process.stdout.write("no federation members registered (see `bourdon agent add`)\n");
    return 0;
  }
  for (const agentId of ids) {
    const row = rows[agentId]!;
    const status = row.revoked ? "REVOKED" : String(row.tier ?? "?");
    // `Omit<RegistryRow,…>` over a string-index type widens `grants` to unknown.
    const grants = ((row.grants as string[] | undefined) ?? []).join(", ") || "-";
    process.stdout.write(`${pad(agentId, 30)} ${pad(status, 12)} grants: ${grants}\n`);
  }
  return 0;
}

export function handleAgentRotate(_opts: Dict, args: string[]): number {
  const agentId = String(args[0] ?? "");
  let token: string;
  try {
    token = new FederationRegistry().rotateToken(agentId);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(`rotated ${agentId}\n`);
  process.stdout.write(`token: ${token}\n`);
  process.stderr.write("This token is shown ONCE. The previous token no longer authenticates.\n");
  return 0;
}

export function handleAgentSetTier(opts: Dict, args: string[]): number {
  const agentId = String(args[0] ?? "");
  const tier = String(args[1] ?? "");
  if (tier === "trusted" && isQuarantinedClass(agentId) && !opts.iUnderstandTheRisk) {
    process.stderr.write(
      `refusing: ${JSON.stringify(agentId)} is a quarantined-class agent. ` +
        "Re-run with --i-understand-the-risk to override.\n",
    );
    return 1;
  }
  try {
    new FederationRegistry().setTier(agentId, tier);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(`${agentId} -> tier: ${tier}\n`);
  return 0;
}

export function handleGrant(_opts: Dict, args: string[]): number {
  const [agentId, namespace] = [String(args[0] ?? ""), String(args[1] ?? "")];
  try {
    new FederationRegistry().grant(agentId, namespace);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(`granted ${agentId} read access to namespace ${JSON.stringify(namespace)}\n`);
  return 0;
}

export function handleUngrant(_opts: Dict, args: string[]): number {
  const [agentId, namespace] = [String(args[0] ?? ""), String(args[1] ?? "")];
  try {
    new FederationRegistry().ungrant(agentId, namespace);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(`removed ${agentId} grant on namespace ${JSON.stringify(namespace)}\n`);
  return 0;
}

export function handleRevoke(_opts: Dict, args: string[]): number {
  const agentId = String(args[0] ?? "");
  try {
    new FederationRegistry().revoke(agentId);
  } catch (exc) {
    if (exc instanceof RegistryError) {
      process.stderr.write(`error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  process.stdout.write(
    `revoked ${agentId}: token invalidated, federation access cut. ` +
      `Its audit history remains queryable (\`bourdon audit --agent ${agentId}\`).\n`,
  );
  return 0;
}

function stagingLibrary(opts: Dict): string {
  return opts.library ? String(opts.library) : DEFAULT_LIBRARY_PATH;
}

export function handleStagingList(opts: Dict, _args: string[]): number {
  const staged = listStaged(stagingLibrary(opts));
  if (staged.length === 0) {
    process.stdout.write("no staged writes\n");
    return 0;
  }
  for (const item of staged) {
    process.stdout.write(
      `${pad(item.agentId, 30)} via ${pad(item.caller, 20)} ` +
        `${String(item.entities).padStart(3)} entities ${String(item.sessions).padStart(3)} ` +
        `sessions  staged ${item.ageDays.toFixed(1)}d ago\n`,
    );
  }
  return 0;
}

export async function handleStagingPromote(opts: Dict, args: string[]): Promise<number> {
  const agentId = String(args[0] ?? "");
  let results: Dict[];
  try {
    results = await promote(stagingLibrary(opts), agentId);
  } catch (exc) {
    process.stderr.write(`error: ${exc instanceof Error ? exc.message : String(exc)}\n`);
    return 1;
  }
  for (const s of results) {
    process.stdout.write(
      `promoted ${agentId}: +${Number(s.entities_added ?? 0)} entities ` +
        `(~${Number(s.entities_updated ?? 0)} updated), ` +
        `+${Number(s.sessions_added ?? 0)} sessions (~${Number(s.sessions_updated ?? 0)} updated)\n`,
    );
  }
  return 0;
}

export function handleStagingReject(opts: Dict, args: string[]): number {
  const agentId = String(args[0] ?? "");
  let count: number;
  try {
    count = reject(stagingLibrary(opts), agentId);
  } catch (exc) {
    process.stderr.write(`error: ${exc instanceof Error ? exc.message : String(exc)}\n`);
    return 1;
  }
  process.stdout.write(`rejected ${count} staged write(s) for ${agentId}\n`);
  return 0;
}

export function handleAudit(opts: Dict, _args: string[]): number {
  const entries: AuditEntry[] = new FederationAudit().entries(
    (opts.agent as string | undefined) ?? null,
    Boolean(opts.denials),
    Number(opts.limit ?? 50),
  );
  if (opts.export) {
    for (const entry of entries) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("no audit entries match\n");
    return 0;
  }
  for (const entry of entries) {
    const detail = entry.detail ? `  (${String(entry.detail)})` : "";
    process.stdout.write(
      `${pad(String(entry.ts ?? "?"), 28)} ${pad(String(entry.decision ?? "?"), 5)} ` +
        `${pad(String(entry.agent ?? "?"), 20)} ${pad(String(entry.op ?? "?"), 28)} ` +
        `ns=${entry.namespace ?? "*"}${detail}\n`,
    );
  }
  return 0;
}
