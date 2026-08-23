import { useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Group, Mesh } from "three";

/**
 * A slowly-rotating low-poly metallic gold coin — the RobinLaunch brand mark's
 * 3D accent. Self-contained (no HDR/asset fetch, just three point/ambient
 * lights) so it works offline and under a strict CSP. Default-exported so it
 * can be `React.lazy()`-loaded and never block first paint; the parent only
 * mounts it when `supportsWebGL()` is true, so a headless/blocklisted env
 * shows a static SVG fallback and this `<Canvas>` never renders there.
 *
 * Performance is capped: DPR clamped to [1, 1.5], `low-power` GPU hint, a
 * single tiny mesh, and a small fixed-size canvas.
 */
function SpinningCoin() {
  const group = useRef<Group>(null);
  const coin = useRef<Mesh>(null);

  useFrame((_, delta) => {
    if (group.current) {
      // Gentle continuous spin about the coin's own (Y) axis…
      group.current.rotation.y += delta * 0.7;
    }
    if (coin.current) {
      // …with a slight wobble so the metallic highlight travels across the face.
      coin.current.rotation.x = Math.sin(performance.now() / 1400) * 0.18;
    }
  });

  return (
    <group ref={group}>
      {/* Rotate the disc so its flat faces point along Z (toward the camera). */}
      <mesh ref={coin} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[1, 1, 0.18, 40]} />
        <meshStandardMaterial color="#f5c518" metalness={0.95} roughness={0.28} />
      </mesh>
      {/* Raised inner face ring for a struck-coin read. */}
      <mesh position={[0, 0, 0.1]}>
        <cylinderGeometry args={[0.66, 0.66, 0.06, 36]} />
        <meshStandardMaterial color="#fbbf24" metalness={0.9} roughness={0.35} />
      </mesh>
    </group>
  );
}

export default function Coin3D() {
  return (
    <Canvas
      dpr={[1, 1.5]}
      frameloop="always"
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0, 3.4], fov: 42 }}
      style={{ width: "100%", height: "100%" }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[3, 4, 5]} intensity={2.1} color="#fff4cc" />
      <pointLight position={[-3, -2, 2]} intensity={1.4} color="#a3e635" />
      <SpinningCoin />
    </Canvas>
  );
}
