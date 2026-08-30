"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

export interface ModelDimensions {
  x: number;
  y: number;
  z: number;
}

interface StlMeshProps {
  buffer: ArrayBuffer;
  onDimensions?: (dims: ModelDimensions) => void;
  /** Material color (defaults to the neutral print-gray). */
  color?: string;
  /** Invisible meshes still report dimensions and anchor Bounds/Center. */
  visible?: boolean;
}

// Above this, flat shading speckles: triangles go sub-pixel and every pixel
// straddles many differently-lit facets (AI-generated statues are ~500K).
// Shade those with CREASED normals: smooth across organic surfaces, but
// hard edges above the crease angle stay crisp — full smoothing melted
// embossed text and plaque corners on statue+pedestal composites.
// CSG-style models stay faceted, which is the truthful slicer-like look.
const SMOOTH_SHADING_TRIANGLE_THRESHOLD = 150_000;
const CREASE_ANGLE = THREE.MathUtils.degToRad(38);

export default function StlMesh({ buffer, onDimensions, color = "#d8dbe0", visible = true }: StlMeshProps) {
  const dimsRef = useRef<ModelDimensions>({ x: 0, y: 0, z: 0 });
  const invalidate = useThree((state) => state.invalidate);

  const { geometry, flatShading } = useMemo(() => {
    let g = new STLLoader().parse(buffer);
    const triangles = g.attributes.position.count / 3;
    const flat = triangles <= SMOOTH_SHADING_TRIANGLE_THRESHOLD;
    if (!flat) {
      // toCreasedNormals welds positions itself and writes normals that are
      // smooth below the crease angle, faceted above it. It may modify the
      // geometry in place (non-indexed input) or return a new one.
      const creased = toCreasedNormals(g, CREASE_ANGLE);
      if (creased !== g) g.dispose();
      g = creased;
    }
    // Printer dimensions (mm) must be read while still Z-up.
    g.computeBoundingBox();
    const size = new THREE.Vector3();
    g.boundingBox!.getSize(size);
    dimsRef.current = { x: size.x, y: size.y, z: size.z };
    // OpenSCAD/printers are Z-up; three.js is Y-up. rotateX also rotates
    // the normal attribute, so creased normals survive.
    g.rotateX(-Math.PI / 2);
    if (flat) g.computeVertexNormals(); // per-face normals for the faceted look
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
    <mesh geometry={geometry} castShadow visible={visible}>
      <meshStandardMaterial color={color} roughness={0.55} metalness={0.1} flatShading={flatShading} />
    </mesh>
  );
}
