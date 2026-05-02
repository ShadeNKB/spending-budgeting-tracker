import { useState } from "react";
import { Cloud, CloudOff, Copy, Check, Link2, Link2Off, RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { useSyncStore } from "../../stores/useSyncStore";
import { syncEnabled } from "../../services/syncService";
import { useToast } from "../../hooks/useToast";
import clsx from "clsx";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function SyncPanel() {
  if (!syncEnabled) return <NotConfigured />;

  return <SyncContent />;
}

function NotConfigured() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
          <CloudOff size={14} className="text-[var(--text-tertiary)]" />
          Cloud sync not configured
        </div>
        <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">
          To enable cross-device sync, add Supabase credentials to your environment.
          Your data stays local-first — Supabase is only used as a relay.
        </p>
        <ol className="mt-1 flex flex-col gap-1.5 text-[12px] text-[var(--text-tertiary)]">
          <li className="flex gap-2">
            <span className="text-accent font-mono">1.</span>
            Create a free project at{" "}
            <span className="font-mono text-white/60">supabase.com</span>
          </li>
          <li className="flex gap-2">
            <span className="text-accent font-mono">2.</span>
            Run the SQL migration from{" "}
            <span className="font-mono text-white/60">supabase/migrations/001_sync.sql</span>
          </li>
          <li className="flex gap-2">
            <span className="text-accent font-mono">3.</span>
            Add{" "}
            <span className="font-mono text-white/60">VITE_SUPABASE_URL</span> and{" "}
            <span className="font-mono text-white/60">VITE_SUPABASE_ANON_KEY</span>{" "}
            to Vercel and your local{" "}
            <span className="font-mono text-white/60">.env.local</span>
          </li>
          <li className="flex gap-2">
            <span className="text-accent font-mono">4.</span>
            Redeploy — sync activates automatically
          </li>
        </ol>
      </div>
    </div>
  );
}

function SyncContent() {
  const syncId = useSyncStore((s) => s.syncId);
  const cloudStatus = useSyncStore((s) => s.cloudStatus);
  const lastSyncAt = useSyncStore((s) => s.lastSyncAt);
  const setupSync = useSyncStore((s) => s.setupSync);
  const disconnectSync = useSyncStore((s) => s.disconnectSync);
  const triggerSync = useSyncStore((s) => s.triggerSync);
  const toast = useToast();

  const [codeInput, setCodeInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const handleGenerate = async () => {
    const id = crypto.randomUUID();
    setConnecting(true);
    try {
      await setupSync(id);
      toast.success("Sync code generated — enter it on your other device");
    } catch {
      toast.error("Failed to set up sync");
    } finally {
      setConnecting(false);
    }
  };

  const handleConnect = async () => {
    const trimmed = codeInput.trim().toLowerCase();
    if (!trimmed) return;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuidRegex.test(trimmed)) {
      toast.error("Invalid sync code — paste the full code from your other device");
      return;
    }
    setConnecting(true);
    try {
      await setupSync(trimmed);
      toast.success("Connected — data synced");
      setCodeInput("");
    } catch {
      toast.error("Failed to connect — check your sync code");
    } finally {
      setConnecting(false);
    }
  };

  const handleCopy = async () => {
    if (!syncId) return;
    await navigator.clipboard.writeText(syncId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleManualSync = async () => {
    try {
      await triggerSync();
      toast.success("Synced");
    } catch {
      toast.error("Sync failed");
    }
  };

  if (!syncId) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
            <Cloud size={14} className="text-accent/60" />
            Set up cross-device sync
          </div>
          <p className="text-[12px] text-[var(--text-tertiary)] leading-relaxed">
            Generate a sync code on this device, then enter it on your other devices.
            No account required — the code is your shared secret.
          </p>
        </div>

        <Button onClick={handleGenerate} variant="primary" disabled={connecting}>
          {connecting ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />}
          {connecting ? "Setting up…" : "Generate sync code for this device"}
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/[0.06]" />
          <span className="text-[11px] text-[var(--text-tertiary)]">or join existing</span>
          <div className="flex-1 h-px bg-white/[0.06]" />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              label=""
              placeholder="Paste sync code from another device"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect();
              }}
            />
          </div>
          <Button
            onClick={handleConnect}
            disabled={!codeInput.trim() || connecting}
            className="mt-0 self-end"
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
            Connect
          </Button>
        </div>
      </div>
    );
  }

  const statusColor: Record<typeof cloudStatus, string> = {
    idle: "text-[var(--text-tertiary)]",
    syncing: "text-accent",
    synced: "text-positive",
    error: "text-negative",
  };

  const statusLabel: Record<typeof cloudStatus, string> = {
    idle: "Ready",
    syncing: "Syncing…",
    synced: lastSyncAt ? `Synced · ${timeAgo(lastSyncAt)}` : "Synced",
    error: "Sync failed",
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-white/[0.06] bg-surface-1 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={clsx(
                "h-2 w-2 rounded-full",
                cloudStatus === "synced" && "bg-positive",
                cloudStatus === "syncing" && "bg-accent animate-pulse",
                cloudStatus === "error" && "bg-negative",
                cloudStatus === "idle" && "bg-white/20"
              )}
            />
            <span className={clsx("text-[12px] font-medium", statusColor[cloudStatus])}>
              {statusLabel[cloudStatus]}
            </span>
          </div>
          <button
            onClick={handleManualSync}
            disabled={cloudStatus === "syncing"}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:text-white hover:bg-surface-2 transition disabled:opacity-40"
            title="Sync now"
          >
            <RefreshCw size={13} className={cloudStatus === "syncing" ? "animate-spin" : ""} />
          </button>
        </div>

        {cloudStatus === "error" && (
          <div className="flex items-center gap-2 rounded-md bg-negative/10 border border-negative/20 px-2.5 py-2 text-[11px] text-negative">
            <AlertCircle size={12} className="shrink-0" />
            Could not reach sync server. Changes saved locally and will push when connection is restored.
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-[var(--text-tertiary)]">Your sync code</span>
          <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-surface-2 px-3 py-2">
            <span className="flex-1 font-mono text-[11px] text-white/70 truncate select-all">
              {syncId}
            </span>
            <button
              onClick={handleCopy}
              className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded text-[var(--text-tertiary)] hover:text-white transition"
              title="Copy sync code"
            >
              {copied ? <Check size={12} className="text-positive" /> : <Copy size={12} />}
            </button>
          </div>
          <p className="text-[11px] text-[var(--text-tertiary)]">
            Enter this code in Settings → Sync on your other devices to link them.
          </p>
        </div>
      </div>

      <div className="border-t border-white/[0.06] pt-3">
        {confirmDisconnect ? (
          <div className="rounded-lg border border-warning/30 bg-warning/[0.07] p-3 flex flex-col gap-2">
            <p className="text-[12px] text-[var(--text-tertiary)]">
              Disconnect sync? Your local data stays intact — other devices stop syncing.
            </p>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  disconnectSync();
                  setConfirmDisconnect(false);
                  toast.info("Sync disconnected");
                }}
                variant="primary"
                className="flex-1 !bg-warning/20 !text-warning border-warning/30 hover:!bg-warning/30"
              >
                Disconnect
              </Button>
              <Button
                onClick={() => setConfirmDisconnect(false)}
                variant="ghost"
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            onClick={() => setConfirmDisconnect(true)}
            variant="ghost"
            className="w-full text-[var(--text-tertiary)] hover:text-white"
          >
            <Link2Off size={14} /> Disconnect sync
          </Button>
        )}
      </div>
    </div>
  );
}
