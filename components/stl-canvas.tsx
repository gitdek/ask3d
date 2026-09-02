"use client";

import { Canvas } from "@react-three/fiber";
import { Bounds, Center, ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import StlMesh, { type ModelDimensions } from "./stl-mesh";

interface StlCanvasProps {
  stl: ArrayBuffer | null;
  /** Per-color meshes (same coordinate frame as `stl`) — rendered tinted
   *  when present; the fused mesh then turns invisible but keeps reporting
   *  dimensions and anchoring Bounds/Center. */
  colorParts?: { hex: string; stl: ArrayBuffer }[] | null;
  onDimensions?: (dims: ModelDimensions) => void;
}

// Stable ids per buffer/parts object: a pure derivation, unlike a render
// counter, so React may re-render freely without the key drifting.
const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
function idOf(value: object | null | undefined): number {
  if (!value) return 0;
  let id = objectIds.get(value);
  if (id === undefined) {
    id = ++nextObjectId;
    objectIds.set(value, id);
  }
  return id;
}

// 1 three.js unit = 1 mm. Bed grid matches a Bambu Lab A1: 256x256mm,
// 10mm cells, 50mm sections.
export default function StlCanvas({ stl, colorParts, onDimensions }: StlCanvasProps) {
  // Bounds fits/clips only on mount and Center measures only on mount —
  // remount the subtree per new buffer so the camera reframes each model.
  const revision = `${idOf(stl)}:${idOf(colorParts)}`;
  const showParts = !!colorParts && colorParts.length >= 2;

  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      shadows
      camera={{ position: [180, 140, 180], fov: 40, near: 1, far: 3000 }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[100, 200, 100]} intensity={1.2} castShadow />
      <Grid
        args={[256, 256]}
        cellSize={10}
        sectionSize={50}
        cellColor="#6b7280"
        sectionColor="#3b82f6"
        fadeDistance={600}
      />
      {stl && (
        <Bounds key={revision} fit clip observe margin={1.4}>
          <Center top>
            <StlMesh buffer={stl} onDimensions={onDimensions} visible={!showParts} />
            {showParts &&
              colorParts!.map((part, i) => (
                <StlMesh key={i} buffer={part.stl} color={part.hex} />
              ))}
          </Center>
        </Bounds>
      )}
      <ContactShadows frames={1} position={[0, -0.01, 0]} scale={250} blur={2} opacity={0.4} />
      <OrbitControls makeDefault minDistance={20} maxDistance={1000} />
    </Canvas>
  );
}
