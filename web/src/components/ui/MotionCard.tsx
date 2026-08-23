import type { ReactNode } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";

/**
 * Reusable animated card primitive later page redesigns build on. Combines the
 * shared `.surface-card` look with a hover-lift and an entrance fade/rise. Drop
 * a set of these inside a `MotionCardGrid` (or any `motion` list) to get a
 * staggered reveal for free. Purely presentational — forwards every extra prop
 * (onClick, role, style…) straight through to the underlying `motion.div`.
 */
export function MotionCard({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & HTMLMotionProps<"div">) {
  return (
    <motion.div
      variants={cardVariants}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 320, damping: 26 }}
      className={`surface-card surface-card-hover ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Entrance variant a `MotionCard` reads from its parent's stagger container. */
export const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

/** Parent container that staggers its `MotionCard` children into view. */
export const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
