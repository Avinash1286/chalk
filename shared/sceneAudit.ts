export type SceneAuditResult = {
  sceneId: string;
  pass: boolean;
  score: number;
  issues: string[];
};

export function sanitizeSceneAudit(raw: unknown, sceneIds: string[]): SceneAuditResult[] {
  const rows = raw && typeof raw === "object" && Array.isArray((raw as { scenes?: unknown }).scenes)
    ? (raw as { scenes: unknown[] }).scenes
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const value = row as Record<string, unknown>;
    const suppliedId = typeof value.sceneId === "string" ? value.sceneId : undefined;
    if (suppliedId && !sceneIds.includes(suppliedId)) return;
    const sceneId = suppliedId ?? sceneIds[index];
    if (sceneId && !byId.has(sceneId)) byId.set(sceneId, value);
  });

  return sceneIds.map((sceneId) => {
    const row = byId.get(sceneId);
    if (!row) return { sceneId, pass: true, score: 100, issues: [] };
    const numericScore = Number(row.score);
    const score = Number.isFinite(numericScore) ? Math.max(0, Math.min(100, Math.round(numericScore))) : 70;
    const issues = Array.isArray(row.issues)
      ? row.issues
          .filter((issue): issue is string => typeof issue === "string" && issue.trim().length > 0)
          .map((issue) => issue.trim().slice(0, 180))
          .slice(0, 5)
      : [];
    const pass = row.pass === true || (row.pass !== false && score >= 70 && issues.length === 0);
    return { sceneId, pass, score, issues };
  });
}