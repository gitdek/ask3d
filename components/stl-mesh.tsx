"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
}

interface StlMeshProps {
  buffer: ArrayBuffer;
  onDimensions?: (dims: ModelDimensions) => void;
}

export default function StlMesh({ buffer, onDimensions }: StlMeshProps) {
  const dimsRef = useRef<ModelDimensions>({ x: 0, y: 0, z: 0 });
  const invalidate = useThree((state) => state.invalidate);

  const geometry = useMemo(() => {
    const g = new STLLoader().parse(buffer);
    // Printer dimensions (mm) must be read while still Z-up.
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox!.getSize(size);
    dimsRef.current = { x: size.x, y: size.y, z: size.z };
    // OpenSCAD/printers are Z-up; three.js is Y-up.
    g.rotateX(-Math.PI / 2);
    g.computeVertexNormals(); // non-indexed → flat, slicer-like shading
    g.computeBoundingBox();
    return g;
  }, [buffer]);

  useEffect(() => {
    onDimensions?.(dimsRef.current);
    // frameloop="demand": a new model arriving must explicitly request a
    // frame, or the pane stays stale until the user orbits.
    invalidate();
  }, [geometry, onDimensions, invalidate]);

  // R3F auto-dispose doesn't cover useMemo-created geometry on all update
  // paths; without this every recompile leaks GPU memory.
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh geometry={geometry} castShadow>
      <meshStandardMaterial color="#d8dbe0" roughness={0.55} metalness={0.1} flatShading />
    </mesh>
  );
}
