import type { ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

/**
 * Wraps a routed page so it fades/slides in on mount. `AppShell` keys one of
 * these per `location.pathname` inside an `<AnimatePresence>`, so navigating
 * between routes cross-fades the old page out and the new page in. Respects
 * `prefers-reduced-motion` by collapsing to a plain, instant render.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <>{children}</>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
