"use client";

import { Canvas } from "@react-three/fiber";
import { Bounds, Center, ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import StlMesh, { type ModelDimensions } from "./stl-mesh";

interface StlCanvasProps {
  stl: ArrayBuffer | null;
  onDimensions?: (dims: ModelDimensions) => void;
}

// 1 three.js unit = 1 mm. Bed grid is 220x220mm, 10mm cells, 50mm sections.
export default function StlCanvas({ stl, onDimensions }: StlCanvasProps) {
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
        args={[220, 220]}
        cellSize={10}
        sectionSize={50}
        cellColor="#6b7280"
        sectionColor="#3b82f6"
        fadeDistance={600}
      />
      {stl && (
        <Bounds fit clip observe margin={1.4}>
          <Center top>
            <StlMesh buffer={stl} onDimensions={onDimensions} />
          </Center>
        </Bounds>
      )}
      <ContactShadows frames={1} position={[0, -0.01, 0]} scale={250} blur={2} opacity={0.4} />
      <OrbitControls makeDefault minDistance={20} maxDistance={1000} />
    </Canvas>
  );
}
