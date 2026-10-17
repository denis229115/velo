import { useEffect, useState, type ReactNode } from "react";
import { claimAura, subscribeAura } from "@/components/ui/auraOwner";

export type AuraPalette = "halo" | "intelligence" | "pearl";
export type AuraPhase = "idle" | "working" | "success" | "error";
export type AuraShape = "pill" | "search" | "composer" | "card";

const DEFAULT_PRIORITY: Record<AuraPalette, number> = {
  halo: 10,
  pearl: 20,
  intelligence: 30,
};

const FADE_MS = 420;

/** Claims the single working glow while `active` is true. */
function useAuraOwner(active: boolean, priority: number): boolean {
  const [owns, setOwns] = useState(false);

  useEffect(() => {
    if (!active) {
      setOwns(false);
      return;
    }
    const claim = claimAura(priority);
    const sync = () => setOwns(claim.owns());
    sync();
    const unsubscribe = subscribeAura(sync);
    return () => {
      unsubscribe();
      claim.release();
    };
  }, [active, priority]);

  return owns;
}

/** Keeps the blobs mounted long enough for the opacity fade after ownership ends. */
function useAuraFade(owns: boolean): { lit: boolean; fading: boolean } {
  const [lit, setLit] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (owns) {
      setLit(true);
      setFading(false);
      return;
    }
    if (!lit) return;
    setFading(true);
    const timer = window.setTimeout(() => {
      setLit(false);
      setFading(false);
    }, FADE_MS);
    return () => window.clearTimeout(timer);
  }, [owns, lit]);

  return { lit, fading };
}

function AuraBlobs({ className }: { className?: string }) {
  const classes = className ? `aura-blobs ${className}` : "aura-blobs";
  return (
    <span className={classes} aria-hidden>
      <i className="aura-blob" />
      <i className="aura-blob" />
      <i className="aura-blob" />
      <i className="aura-blob" />
    </span>
  );
}

/** A slow sheen over placeholder text. The motion is transform and opacity. */
export function AuraShimmer({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={className ? `aura-shimmer ${className}` : "aura-shimmer"}>
      {children}
      <span className="aura-shimmer-sheen" aria-hidden />
    </span>
  );
}

interface AuraGlowProps {
  palette: AuraPalette;
  phase?: AuraPhase;
  /** Higher priority takes the single working glow. Ties keep the newer claim. */
  priority?: number;
  /** Shown over the field only while this field owns the working glow. */
  shimmer?: string;
  shape?: AuraShape;
  /** `field` is the glass capsule. `plain` masks around an existing surface. */
  variant?: "field" | "plain";
  className?: string;
  fieldClassName?: string;
  children: ReactNode;
}

/**
 * Soft radial colour behind a field. The mask punches the glow out of the
 * field shape so the field's own glass blur stays visible.
 */
export function AuraGlow({
  palette,
  phase = "idle",
  priority,
  shimmer,
  shape = "pill",
  variant = "field",
  className,
  fieldClassName,
  children,
}: AuraGlowProps) {
  const resolvedPriority = priority ?? DEFAULT_PRIORITY[palette];
  const owns = useAuraOwner(phase === "working", resolvedPriority);
  const glow = useAuraFade(owns);
  const classes = [
    "aura",
    `aura-${palette}`,
    `aura-shape-${shape}`,
    phase === "working" && owns ? "aura-working" : "",
    phase === "success" ? "aura-success" : "",
    phase === "error" ? "aura-error" : "",
    glow.fading ? "aura-fade" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
  const fieldClasses = [
    "aura-field",
    variant === "field" ? "material-pop aura-field-glass" : "",
    fieldClassName ?? "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes} data-aura-phase={phase} data-aura-on={owns ? "true" : "false"}>
      {glow.lit && (
        <span className="aura-mask" aria-hidden>
          <AuraBlobs />
        </span>
      )}
      <div className={fieldClasses}>
        {glow.lit && <AuraBlobs className="aura-blobs-in" />}
        {variant === "field" && <span className="aura-grain" aria-hidden />}
        <div className="aura-content">
          {children}
          {shimmer && owns && (
            <span className="pointer-events-none absolute inset-0 z-[2] flex items-center">
              <AuraShimmer>{shimmer}</AuraShimmer>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
