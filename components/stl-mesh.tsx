"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
}

interface StlMeshProps {
  buffer: ArrayBuffer;
  onDimensions?: (dims: ModelDimensions) => void;
}

// Above this, flat shading speckles: triangles go sub-pixel and every pixel
// straddles many differently-lit facets (AI-generated statues are ~500K).
// Weld vertices and shade smooth instead; CSG-style models stay faceted,
// which is the truthful slicer-like look.
const SMOOTH_SHADING_TRIANGLE_THRESHOLD = 150_000;

export default function StlMesh({ buffer, onDimensions }: StlMeshProps) {
  const dimsRef = useRef<ModelDimensions>({ x: 0, y: 0, z: 0 });
  const invalidate = useThree((state) => state.invalidate);

  const { geometry, flatShading } = useMemo(() => {
    let g = new STLLoader().parse(buffer);
    const triangles = g.attributes.position.count / 3;
    const flat = triangles <= SMOOTH_SHADING_TRIANGLE_THRESHOLD;
    if (!flat) {
      // Position-only copy first: STL has per-face normals baked per vertex,
      // and mergeVertices only welds vertices identical across ALL attributes.
      const positionsOnly = new THREE.BufferGeometry();
      positionsOnly.setAttribute("position", g.getAttribute("position"));
      const welded = mergeVertices(positionsOnly, 1e-4);
      g.dispose();
      g = welded;
    }
    // Printer dimensions (mm) must be read while still Z-up.
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox!.getSize(size);
    dimsRef.current = { x: size.x, y: size.y, z: size.z };
    // OpenSCAD/printers are Z-up; three.js is Y-up.
    g.rotateX(-Math.PI / 2);
    g.computeVertexNormals(); // flat on non-indexed, smooth on welded
    g.computeBoundingBox();
    return { geometry: g, flatShading: flat };
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
      <meshStandardMaterial color="#d8dbe0" roughness={0.55} metalness={0.1} flatShading={flatShading} />
    </mesh>
  );
}
