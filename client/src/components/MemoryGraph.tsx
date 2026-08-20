import { useEffect, useRef, useState } from "react";
import { BookOpen, Crosshair, Focus, Minus, MoreHorizontal, Plus, RotateCcw, Trash2 } from "lucide-react";
import * as THREE from "three";
import { DragControls } from "three/examples/jsm/controls/DragControls.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { MemoryGraphEdge, MemoryGraphNode } from "../lib/memory-types";

const SHELL_RADIUS = 92;
const CAMERA_DISTANCE = 255;
const LABEL_REVEAL_RADIUS_PX = 24;
const LABEL_FOCUS_MIN_RADIUS_PX = 54;
const PRIMARY_MEMORY_TITLE = "me (exampleUser user)";
const LAYOUT_STORAGE_KEY = "jarvis-memory-brain-layout-v2";

type NodeRecord = {
  data: MemoryGraphNode;
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  halo: THREE.Sprite;
  anchor: THREE.Vector3;
  velocity: THREE.Vector3;
  dragging: boolean;
  manuallyPlaced: boolean;
  phase: number;
  /** The opacity this node was built with, so focus dimming is reversible. */
  baseOpacity: number;
  /** Eased 1 → DIMMED_FACTOR, so focus fades in rather than snapping. */
  dim?: number;
};

type EdgeRecord = {
  data: MemoryGraphEdge;
  source: NodeRecord;
  target: NodeRecord;
  line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  pulse: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  baseOpacity: number;
  dim?: number;
  phase: number;
  strands: number;
  segmentStep: number;
};

// How far unrelated nodes recede when one is selected. Enough to read the connected set at a
// glance, not so far that the rest of the graph disappears and loses its shape.
const DIMMED_FACTOR = 0.18;

type SceneApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
  focusNode: (id: string) => void;
  resetNode: (id: string) => void;
  nudgeSelected: (horizontal: number, vertical: number) => void;
};

type ContextMenuState = { id: string; x: number; y: number };

export default function MemoryGraph({
  nodes,
  edges,
  selectedId,
  onSelect,
  onDelete,
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelCanvasRef = useRef<HTMLCanvasElement>(null);
  const rebuildRef = useRef<((nextNodes: MemoryGraphNode[], nextEdges: MemoryGraphEdge[]) => void) | null>(null);
  const sceneApiRef = useRef<SceneApi | null>(null);
  const propsRef = useRef({ nodes, edges, selectedId, onSelect, onDelete });
  propsRef.current = { nodes, edges, selectedId, onSelect, onDelete };

  const [zoomPercent, setZoomPercent] = useState(100);
  const [sceneStatus, setSceneStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    const labelCanvas = labelCanvasRef.current;
    if (!mount || !labelCanvas) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setSceneStatus("failed");
      return;
    }

    renderer.setClearColor(0x01060d, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "memory-vault-webgl";
    renderer.domElement.setAttribute("aria-hidden", "true");
    mount.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x01060d, 0.0016);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1400);
    camera.position.set(0, 38, CAMERA_DISTANCE);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.075;
    orbit.enablePan = false;
    orbit.minDistance = 115;
    orbit.maxDistance = 430;
    orbit.rotateSpeed = 0.42;
    orbit.zoomSpeed = 0.72;
    orbit.autoRotate = false;
    orbit.zoomToCursor = true;

    scene.add(new THREE.AmbientLight(0x17334d, 1.7));
    const coreLight = new THREE.PointLight(0x7de8ff, 1100, 240, 1.6);
    scene.add(coreLight);

    const farStars = buildStarfield(760, 155, 520, 0.7, 0.56, 47);
    const nearStars = buildStarfield(190, 130, 330, 1.18, 0.78, 91);
    const brightStars = buildStarfield(44, 150, 430, 2.15, 0.9, 173);
    scene.add(farStars, nearStars, brightStars);

    const vaultGroup = new THREE.Group();
    scene.add(vaultGroup);

    const glowTexture = buildGlowTexture();
    const coreGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: 0x89ecff,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    coreGlow.scale.setScalar(42);
    vaultGroup.add(coreGlow);

    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(7.5, 0),
      new THREE.MeshPhysicalMaterial({
        color: 0xb9f6ff,
        emissive: 0x43c9ef,
        emissiveIntensity: 2.25,
        metalness: 0.2,
        roughness: 0.08,
        transmission: 0.28,
        transparent: true,
        opacity: 0.88,
      }),
    );
    vaultGroup.add(core);
    const coreCage = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.OctahedronGeometry(11, 1)),
      new THREE.LineBasicMaterial({
        color: 0xb5f8ff,
        transparent: true,
        opacity: 0.58,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    vaultGroup.add(coreCage);

    const magentaRay = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-10, -4, 0),
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(10, 4, 0),
      ]),
      new THREE.LineBasicMaterial({
        color: 0xff8bc7,
        transparent: true,
        opacity: 0.52,
        blending: THREE.AdditiveBlending,
      }),
    );
    vaultGroup.add(magentaRay);

    const synapticDust = buildSynapticDust(260);
    vaultGroup.add(synapticDust);

    const graphGroup = new THREE.Group();
    const connectionGroup = new THREE.Group();
    vaultGroup.add(graphGroup, connectionGroup);

    const haloTexture = buildGlowTexture();
    let nodeRecords = new Map<string, NodeRecord>();
    let edgeRecords: EdgeRecord[] = [];
    let filaments: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
    let dragControls: DragControls | null = null;
    let lastInteractionAt = performance.now();
    let cameraInteracting = false;
    let nodeInteracting = false;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const labelFocusPoint = new THREE.Vector2();
    let labelFocusInitialized = false;

    const updateLabelFocus = (event: PointerEvent | WheelEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      labelFocusPoint.set(event.clientX - bounds.left, event.clientY - bounds.top);
      labelFocusInitialized = true;
    };
    renderer.domElement.addEventListener("pointermove", updateLabelFocus);
    renderer.domElement.addEventListener("wheel", updateLabelFocus, { passive: true });

    const markInteraction = () => {
      lastInteractionAt = performance.now();
    };
    const onOrbitStart = () => {
      cameraInteracting = true;
      markInteraction();
    };
    const onOrbitEnd = () => {
      cameraInteracting = false;
      markInteraction();
    };
    orbit.addEventListener("start", onOrbitStart);
    orbit.addEventListener("end", onOrbitEnd);

    const updateZoomPercent = () => {
      const distance = camera.position.distanceTo(orbit.target);
      setZoomPercent(Math.round((CAMERA_DISTANCE / distance) * 100));
    };
    orbit.addEventListener("change", updateZoomPercent);

    const disposeGraph = () => {
      dragControls?.dispose();
      dragControls = null;
      disposeChildren(graphGroup);
      disposeChildren(connectionGroup);
      nodeRecords.clear();
      edgeRecords = [];
      filaments = null;
    };

    const clampNode = (object: THREE.Object3D) => {
      const distance = object.position.length();
      if (distance > SHELL_RADIUS - 12) object.position.setLength(SHELL_RADIUS - 12);
      if (distance < 30) {
        if (distance < 0.001) object.position.set(30, 0, 0);
        else object.position.setLength(30);
      }
    };

    const persistLayout = () => {
      const layout: Record<string, [number, number, number]> = {};
      for (const [id, record] of nodeRecords) {
        if (!record.manuallyPlaced) continue;
        layout[id] = [record.mesh.position.x, record.mesh.position.y, record.mesh.position.z];
      }
      try {
        localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
      } catch {
        // Layout persistence is optional; the vault data remains untouched.
      }
    };

    const rebuild = (nextNodes: MemoryGraphNode[], nextEdges: MemoryGraphEdge[]) => {
      const previous = new Map([...nodeRecords].map(([id, record]) => [id, record.mesh.position.clone()]));
      const saved = readSavedLayout();
      disposeGraph();

      const degree = new Map<string, number>();
      for (const edge of nextEdges) {
        if (edge.state === "candidate") continue;
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
      }

      for (let index = 0; index < nextNodes.length; index += 1) {
        const data = nextNodes[index];
        const cluster = clusterForMemory(data);
        const color = cluster.color;
        const material = new THREE.MeshPhysicalMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.6,
          metalness: 0.2,
          roughness: 0.13,
          clearcoat: 0.76,
          clearcoatRoughness: 0.17,
          transmission: 0.14,
          transparent: true,
          opacity: 0.94,
        });
        if (data.memoryState === "superseded") {
          material.opacity = 0.48;
          material.emissiveIntensity = 0.7;
        }
        const radius = Math.min(8.4, 5.4 + Math.sqrt(degree.get(data.id) ?? 0) * 0.72);
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 20), material);
        mesh.name = data.id;
        mesh.userData.memoryId = data.id;
        const anchor = clusterNodePosition(data, index);
        const storedPosition = savedPosition(saved, data.id);
        mesh.position.copy(previous.get(data.id) ?? storedPosition ?? anchor);
        clampNode(mesh);

        const haloMaterial = new THREE.SpriteMaterial({
          map: haloTexture,
          color,
          transparent: true,
          opacity: 0.72,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const halo = new THREE.Sprite(haloMaterial);
        halo.scale.setScalar(radius * 5.15);
        halo.raycast = () => undefined;
        mesh.add(halo);
        graphGroup.add(mesh);
        nodeRecords.set(data.id, {
          baseOpacity: mesh.material.opacity,
          data,
          mesh,
          halo,
          anchor: storedPosition?.clone() ?? anchor,
          velocity: new THREE.Vector3(),
          dragging: false,
          manuallyPlaced: Boolean(storedPosition),
          phase: hashString(data.id) * 0.0001,
        });
      }

      const filamentPositions = new Float32Array(nodeRecords.size * 2 * 3);
      const filamentGeometry = new THREE.BufferGeometry();
      filamentGeometry.setAttribute("position", new THREE.BufferAttribute(filamentPositions, 3));
      filaments = new THREE.LineSegments(
        filamentGeometry,
        new THREE.LineBasicMaterial({
          color: 0x69dbf7,
          transparent: true,
          opacity: 0.075,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      connectionGroup.add(filaments);

      for (const edge of nextEdges) {
        const source = nodeRecords.get(edge.source);
        const target = nodeRecords.get(edge.target);
        if (!source || !target) continue;
        const strands = THREE.MathUtils.clamp(Math.round(edge.weight * 4), 1, 4);
        const segmentStep = edge.state === "candidate" ? 2 : 1;
        const segmentCount = Math.ceil(24 / segmentStep);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(strands * segmentCount * 2 * 3), 3),
        );
        const line = new THREE.LineSegments(
          geometry,
          new THREE.LineBasicMaterial({
            color: relationColor(edge.relationType, edge.state),
            transparent: true,
            opacity: edge.state === "candidate" ? 0.34 : 0.28 + edge.weight * 0.46,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        const pulse = new THREE.Mesh(
          new THREE.SphereGeometry(0.72 + edge.weight * 0.72, 10, 8),
          new THREE.MeshBasicMaterial({ color: relationColor(edge.relationType, edge.state) }),
        );
        connectionGroup.add(line, pulse);
        edgeRecords.push({
          data: edge,
          source,
          target,
          line,
          pulse,
          // The opacity this edge was designed with, so fading is reversible rather than cumulative.
          baseOpacity: (line.material as THREE.LineBasicMaterial).opacity,
          phase: (hashString(edge.id) % 1000) / 1000,
          strands,
          segmentStep,
        });
      }

      const draggable = [...nodeRecords.values()].map((record) => record.mesh);
      dragControls = new DragControls(draggable, camera, renderer.domElement);
      dragControls.recursive = false;
      dragControls.addEventListener("hoveron", () => {
        renderer.domElement.style.cursor = "move";
      });
      dragControls.addEventListener("hoveroff", () => {
        renderer.domElement.style.cursor = "grab";
      });
      dragControls.addEventListener("dragstart", (event) => {
        orbit.enabled = false;
        nodeInteracting = true;
        markInteraction();
        renderer.domElement.classList.add("is-dragging-node");
        const id = event.object.userData.memoryId;
        if (typeof id === "string") {
          const record = nodeRecords.get(id);
          if (record) record.dragging = true;
          propsRef.current.onSelect(id);
          setContextMenu(null);
        }
      });
      dragControls.addEventListener("drag", (event) => {
        clampNode(event.object);
      });
      dragControls.addEventListener("dragend", (event) => {
        renderer.domElement.classList.remove("is-dragging-node");
        const id = event.object.userData.memoryId;
        if (typeof id === "string") {
          const record = nodeRecords.get(id);
          if (record) {
            record.dragging = false;
            record.manuallyPlaced = true;
            record.anchor.copy(record.mesh.position);
            record.velocity.set(0, 0, 0);
          }
        }
        orbit.enabled = true;
        nodeInteracting = false;
        markInteraction();
        persistLayout();
      });
    };
    rebuildRef.current = rebuild;

    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.min(window.innerWidth < 640 ? 1.3 : 1.75, window.devicePixelRatio || 1);
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      labelCanvas.width = Math.round(width * dpr);
      labelCanvas.height = Math.round(height * dpr);
      labelCanvas.style.width = `${width}px`;
      labelCanvas.style.height = `${height}px`;
      if (!labelFocusInitialized) labelFocusPoint.set(width / 2, height / 2);
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    let visible = true;
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    visibilityObserver.observe(mount);

    const shootingStar = buildShootingStar();
    scene.add(shootingStar.line);
    let nextShootingStar = performance.now() + 1250;
    let shootingStarStarted = 0;

    let raf = 0;
    let last = performance.now();
    const labelContext = labelCanvas.getContext("2d");
    const curveControl = new THREE.Vector3();
    const curve = new THREE.QuadraticBezierCurve3();
    const nodeScale = new THREE.Vector3();
    // Reused each frame rather than reallocated: this runs at animation rate.
    const focusedIds = new Set<string>();
    const edgeMiddle = new THREE.Vector3();
    const edgeDirection = new THREE.Vector3();
    const edgeNormal = new THREE.Vector3();
    const edgeUp = new THREE.Vector3(0, 1, 0);
    const edgePointA = new THREE.Vector3();
    const edgePointB = new THREE.Vector3();

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible || document.hidden) return;
      const deltaSeconds = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (!reducedMotion) {
        const idle = !cameraInteracting && !nodeInteracting && now - lastInteractionAt > 2200;
        if (idle) vaultGroup.rotation.y += deltaSeconds * 0.042;
        core.rotation.y += deltaSeconds * 0.34;
        core.rotation.x += deltaSeconds * 0.12;
        coreCage.rotation.y -= deltaSeconds * 0.24;
        farStars.rotation.y += deltaSeconds * 0.0025;
        nearStars.rotation.x -= deltaSeconds * 0.0014;
        brightStars.rotation.y -= deltaSeconds * 0.0012;
        synapticDust.rotation.y -= deltaSeconds * 0.006;
      }

      tickClusterLayout(nodeRecords, edgeRecords, deltaSeconds, reducedMotion);

      const selected = propsRef.current.selectedId;
      // Which nodes the selected one actually touches. Rebuilt per frame because edges are live:
      // a connection created or archived while the graph is open changes the answer immediately.
      focusedIds.clear();
      if (selected) {
        focusedIds.add(selected);
        for (const edge of edgeRecords) {
          if (edge.source.data.id === selected) focusedIds.add(edge.target.data.id);
          else if (edge.target.data.id === selected) focusedIds.add(edge.source.data.id);
        }
      }
      const hasFocus = focusedIds.size > 1;

      for (const record of nodeRecords.values()) {
        const isSelected = record.data.id === selected;
        // Dim only when the selection actually has neighbours; an isolated node would otherwise
        // fade the entire graph and leave nothing to read.
        const dimmed = hasFocus && !focusedIds.has(record.data.id);
        const targetDim = dimmed ? DIMMED_FACTOR : 1;
        record.dim = record.dim === undefined ? targetDim : record.dim + (targetDim - record.dim) * 0.14;
        const pulse = reducedMotion ? 1 : 1 + Math.sin(now * 0.0014 + record.phase) * 0.045;
        const targetScale = (isSelected ? 1.14 : 1) * pulse;
        record.mesh.scale.lerp(nodeScale.setScalar(targetScale), 0.12);
        const superseded = record.data.memoryState === "superseded";
        record.mesh.material.emissiveIntensity =
          (superseded ? (isSelected ? 1.2 : 0.7) : (isSelected ? 2.6 : 1.55)) * record.dim;
        record.mesh.material.opacity = record.baseOpacity * record.dim;
        record.halo.material.opacity =
          (superseded ? (isSelected ? 0.5 : 0.24) : (isSelected ? 0.92 : 0.6)) * record.dim;
      }

      if (filaments) {
        const positions = filaments.geometry.getAttribute("position") as THREE.BufferAttribute;
        let index = 0;
        for (const record of nodeRecords.values()) {
          positions.setXYZ(index++, 0, 0, 0);
          positions.setXYZ(
            index++,
            record.mesh.position.x * 0.72,
            record.mesh.position.y * 0.72,
            record.mesh.position.z * 0.72,
          );
        }
        positions.needsUpdate = true;
      }

      for (const edge of edgeRecords) {
        // An edge is part of the focus only if the selected node is one of its ends.
        const edgeDimmed =
          hasFocus && edge.source.data.id !== selected && edge.target.data.id !== selected;
        const edgeTargetDim = edgeDimmed ? DIMMED_FACTOR : 1;
        edge.dim = edge.dim === undefined ? edgeTargetDim : edge.dim + (edgeTargetDim - edge.dim) * 0.14;
        edge.line.material.opacity = edge.baseOpacity * edge.dim;
        edge.pulse.material.opacity = edge.dim;
        edge.pulse.material.transparent = true;
        edgeMiddle.copy(edge.source.mesh.position).add(edge.target.mesh.position).multiplyScalar(0.5);
        curveControl.copy(edgeMiddle).multiplyScalar(1.34);
        curve.v0.copy(edge.source.mesh.position);
        curve.v1.copy(curveControl);
        curve.v2.copy(edge.target.mesh.position);
        const positions = edge.line.geometry.getAttribute("position") as THREE.BufferAttribute;
        edgeDirection.copy(edge.target.mesh.position).sub(edge.source.mesh.position).normalize();
        edgeNormal.copy(edgeDirection).cross(edgeUp);
        if (edgeNormal.lengthSq() < 0.001) edgeNormal.set(1, 0, 0);
        edgeNormal.normalize();
        let positionIndex = 0;
        for (let strand = 0; strand < edge.strands; strand += 1) {
          const offset = (strand - (edge.strands - 1) / 2) * 0.34;
          for (let segment = 0; segment < 24; segment += edge.segmentStep) {
            edgePointA.copy(curve.getPoint(segment / 24)).addScaledVector(edgeNormal, offset);
            edgePointB.copy(curve.getPoint((segment + 1) / 24)).addScaledVector(edgeNormal, offset);
            positions.setXYZ(positionIndex++, edgePointA.x, edgePointA.y, edgePointA.z);
            positions.setXYZ(positionIndex++, edgePointB.x, edgePointB.y, edgePointB.z);
          }
        }
        positions.needsUpdate = true;
        const progress = reducedMotion ? 0.5 : (now * 0.00012 + edge.phase) % 1;
        edge.pulse.position.copy(curve.getPoint(progress));
        edge.pulse.visible = !reducedMotion && edge.data.state === "approved";
      }

      if (!reducedMotion) {
        if (!shootingStar.line.visible && now >= nextShootingStar) {
          shootingStarStarted = now;
          shootingStar.line.visible = true;
        }
        if (shootingStar.line.visible) {
          const progress = (now - shootingStarStarted) / 950;
          if (progress >= 1) {
            shootingStar.line.visible = false;
            nextShootingStar = now + 7000 + seededJitter(now) * 7000;
          } else {
            updateShootingStar(shootingStar, progress);
          }
        }
      }

      orbit.update(deltaSeconds);
      renderer.render(scene, camera);
      drawLabels(labelContext, labelCanvas, renderer, camera, labelFocusPoint, vaultGroup, nodeRecords, selected);
    };
    raf = requestAnimationFrame(draw);

    const moveCamera = (factor: number) => {
      const offset = camera.position.clone().sub(orbit.target);
      const distance = THREE.MathUtils.clamp(offset.length() * factor, orbit.minDistance, orbit.maxDistance);
      camera.position.copy(orbit.target).add(offset.setLength(distance));
      orbit.update();
      updateZoomPercent();
    };
    const focusNode = (id: string) => {
      const record = nodeRecords.get(id);
      if (!record) return;
      const target = record.mesh.getWorldPosition(new THREE.Vector3());
      const direction = camera.position.clone().sub(orbit.target).normalize();
      orbit.target.copy(target);
      camera.position.copy(target).addScaledVector(direction, 138);
      labelFocusPoint.set(renderer.domElement.clientWidth / 2, renderer.domElement.clientHeight / 2);
      labelFocusInitialized = true;
      orbit.update();
      markInteraction();
      updateZoomPercent();
    };

    sceneApiRef.current = {
      zoomIn: () => moveCamera(0.84),
      zoomOut: () => moveCamera(1.16),
      resetView: () => {
        camera.position.set(0, 38, CAMERA_DISTANCE);
        orbit.target.set(0, 0, 0);
        vaultGroup.rotation.set(0, 0, 0);
        orbit.update();
        markInteraction();
        updateZoomPercent();
      },
      focusNode,
      resetNode: (id) => {
        const record = nodeRecords.get(id);
        if (!record) return;
        removeSavedPosition(id);
        record.manuallyPlaced = false;
        record.anchor.copy(clusterNodePosition(record.data, 0));
        record.mesh.position.copy(record.anchor);
        record.velocity.set(0, 0, 0);
        persistLayout();
      },
      nudgeSelected: (horizontal, vertical) => {
        const id = propsRef.current.selectedId;
        const record = id ? nodeRecords.get(id) : null;
        if (!record) return;
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        record.mesh.position.addScaledVector(right, horizontal).addScaledVector(up, vertical);
        clampNode(record.mesh);
        record.manuallyPlaced = true;
        record.anchor.copy(record.mesh.position);
        markInteraction();
        persistLayout();
      },
    };

    const pickNode = (clientX: number, clientY: number) => {
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((clientX - bounds.left) / bounds.width) * 2 - 1,
        -((clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects([...nodeRecords.values()].map((record) => record.mesh), false)[0];
      const id = hit?.object.userData.memoryId;
      return typeof id === "string" ? id : null;
    };

    const openNodeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const id = pickNode(event.clientX, event.clientY);
      if (!id) {
        setContextMenu(null);
        return;
      }
      const bounds = mount.getBoundingClientRect();
      propsRef.current.onSelect(id);
      markInteraction();
      setContextMenu({
        id,
        x: THREE.MathUtils.clamp(event.clientX - bounds.left, 10, bounds.width - 178),
        y: THREE.MathUtils.clamp(event.clientY - bounds.top, 10, bounds.height - 150),
      });
    };
    // Clicking empty space clears the selection, which un-dims the whole graph.
    //
    // The canvas is also the orbit control's surface, so a drag to rotate the view must not count
    // as a click. Distance and duration since pointerdown separate the two: a rotate moves the
    // pointer, a click does not.
    let pressAt: { x: number; y: number; at: number } | null = null;
    const rememberPress = (event: PointerEvent) => {
      pressAt = { x: event.clientX, y: event.clientY, at: performance.now() };
    };
    const clearSelectionOnEmptyClick = (event: PointerEvent) => {
      const press = pressAt;
      pressAt = null;
      if (!press || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (moved > 6 || performance.now() - press.at > 500) return;
      if (pickNode(event.clientX, event.clientY)) return;
      setContextMenu(null);
      if (propsRef.current.selectedId) propsRef.current.onSelect(null);
    };
    renderer.domElement.addEventListener("pointerdown", rememberPress);
    renderer.domElement.addEventListener("pointerup", clearSelectionOnEmptyClick);
    renderer.domElement.addEventListener("contextmenu", openNodeContextMenu);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setSceneStatus("failed");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    setSceneStatus("ready");

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("pointerdown", rememberPress);
      renderer.domElement.removeEventListener("pointerup", clearSelectionOnEmptyClick);
      renderer.domElement.removeEventListener("contextmenu", openNodeContextMenu);
      renderer.domElement.removeEventListener("pointermove", updateLabelFocus);
      renderer.domElement.removeEventListener("wheel", updateLabelFocus);
      orbit.removeEventListener("change", updateZoomPercent);
      orbit.removeEventListener("start", onOrbitStart);
      orbit.removeEventListener("end", onOrbitEnd);
      orbit.dispose();
      disposeGraph();
      disposeScene(scene);
      glowTexture.dispose();
      haloTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      rebuildRef.current = null;
      sceneApiRef.current = null;
    };
  }, []);

  useEffect(() => {
    rebuildRef.current?.(nodes, edges);
  }, [edges, nodes]);

  const selectedTitle = nodes.find((node) => node.id === selectedId)?.title;
  const contextMemory = contextMenu ? nodes.find((node) => node.id === contextMenu.id) : null;
  const sceneLabel = [
    `3D memory relationship graph with ${nodes.length} ${nodes.length === 1 ? "node" : "nodes"} and ${edges.length} ${edges.length === 1 ? "connection" : "connections"}.`,
    selectedTitle ? `Selected memory: ${selectedTitle}.` : "No memory selected.",
    "Drag nodes with a pointer, use arrow keys to nudge the selected node, and use the controls to zoom or reset the view.",
  ].join(" ");

  function handleGraphKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      setContextMenu(null);
      return;
    }
    if ((event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) && selectedId) {
      const bounds = mountRef.current?.getBoundingClientRect();
      setContextMenu({ id: selectedId, x: Math.max(10, (bounds?.width ?? 360) / 2 - 84), y: 70 });
      event.preventDefault();
      return;
    }
    const nudge = event.shiftKey ? 8 : 3;
    if (event.key === "ArrowLeft") sceneApiRef.current?.nudgeSelected(-nudge, 0);
    else if (event.key === "ArrowRight") sceneApiRef.current?.nudgeSelected(nudge, 0);
    else if (event.key === "ArrowUp") sceneApiRef.current?.nudgeSelected(0, nudge);
    else if (event.key === "ArrowDown") sceneApiRef.current?.nudgeSelected(0, -nudge);
    else return;
    event.preventDefault();
  }

  return (
    <section className="memory-graph-panel" aria-label={sceneLabel}>
      <div className="memory-panel-heading">
        <div>
          <div className="hud-label">WIKI MAP</div>
          <div className="memory-panel-subtitle">
            {nodes.length} {nodes.length === 1 ? "node" : "nodes"} · {edges.length}{" "}
            {edges.length === 1 ? "connection" : "connections"}
          </div>
        </div>
        <div className="memory-graph-controls" aria-label="Graph zoom controls">
          <button onClick={() => sceneApiRef.current?.zoomOut()} aria-label="Zoom out">
            <Minus size={15} />
          </button>
          <span>{zoomPercent}%</span>
          <button onClick={() => sceneApiRef.current?.zoomIn()} aria-label="Zoom in">
            <Plus size={15} />
          </button>
          <button onClick={() => sceneApiRef.current?.resetView()} aria-label="Reset graph view">
            <Focus size={15} />
          </button>
          <button
            onClick={() => selectedId && setContextMenu({ id: selectedId, x: 12, y: 66 })}
            aria-label="Open selected memory actions"
            disabled={!selectedId}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      </div>

      <div
        ref={mountRef}
        className="memory-graph-canvas memory-vault-space"
        tabIndex={0}
        role="application"
        aria-label={sceneLabel}
        onKeyDown={handleGraphKeyDown}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest(".memory-node-menu")) setContextMenu(null);
        }}
      >
        <canvas ref={labelCanvasRef} className="memory-vault-labels" aria-hidden="true" />

        {sceneStatus === "failed" ? (
          <div className="memory-vault-fallback" role="group" aria-label="Memory graph fallback">
            <div className="memory-vault-fallback__sphere" />
            <p>3D view unavailable. Select a memory below.</p>
            {nodes.map((node) => (
              <button key={node.id} onClick={() => onSelect(node.id)}>
                {node.title}
              </button>
            ))}
          </div>
        ) : null}

        {nodes.length === 0 && sceneStatus !== "loading" ? (
          <div className="memory-empty-graph">
            <div className="memory-empty-graph__core" />
            <strong>No memories yet</strong>
            <span>Create a memory to begin the graph.</span>
          </div>
        ) : null}

        <div className="memory-vault-instruction" aria-hidden="true">
          DRAG NODE · ORBIT SPACE · <span className="memory-vault-instruction__desktop">SCROLL</span>
          <span className="memory-vault-instruction__mobile">PINCH</span> TO ZOOM
        </div>
        <div className="memory-graph-legend" aria-label="Node source legend">
          <span><i className="memory-legend-dot" /> Color = memory cluster</span>
          <span><i className="memory-legend-line" /> Thick = strong</span>
          <span><i className="memory-legend-line memory-legend-line--candidate" /> Dashed = candidate</span>
        </div>

        {contextMemory && contextMenu ? (
          <div
            className="memory-node-menu"
            role="menu"
            aria-label={`Actions for ${contextMemory.title}`}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="memory-node-menu__title">{contextMemory.title}</div>
            <button role="menuitem" onClick={() => { onSelect(contextMemory.id); setContextMenu(null); }}>
              <BookOpen size={13} /> Open memory
            </button>
            <button role="menuitem" onClick={() => { sceneApiRef.current?.focusNode(contextMemory.id); setContextMenu(null); }}>
              <Crosshair size={13} /> Focus node
            </button>
            <button role="menuitem" onClick={() => { sceneApiRef.current?.resetNode(contextMemory.id); setContextMenu(null); }}>
              <RotateCcw size={13} /> Reset position
            </button>
            <button
              className="memory-node-menu__danger"
              role="menuitem"
              onClick={() => { onDelete(contextMemory.id); setContextMenu(null); }}
            >
              <Trash2 size={13} /> Delete memory
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function buildStarfield(
  count: number,
  minRadius: number,
  maxRadius: number,
  size: number,
  opacity: number,
  seed: number,
) {
  const random = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const starColors = [
    new THREE.Color(0x8eb9ff),
    new THREE.Color(0xd5e8ff),
    new THREE.Color(0xffffff),
    new THREE.Color(0xffefcf),
  ];
  for (let index = 0; index < count; index += 1) {
    const direction = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 2 - 1,
    ).normalize();
    const radius = minRadius + random() * (maxRadius - minRadius);
    positions.set([direction.x * radius, direction.y * radius, direction.z * radius], index * 3);
    const tint = starColors[Math.floor(random() * starColors.length)];
    const brightness = 0.42 + random() * 0.58;
    colors.set([tint.r * brightness, tint.g * brightness, tint.b * brightness], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xffffff,
      size,
      transparent: true,
      opacity,
      sizeAttenuation: true,
      depthWrite: false,
      vertexColors: true,
    }),
  );
}

function relationColor(relationType: MemoryGraphEdge["relationType"], state: MemoryGraphEdge["state"]) {
  if (state === "candidate") return 0xf08bff;
  if (relationType === "contradicts") return 0xff6f7d;
  if (["supports", "caused_by", "derived_from"].includes(relationType)) return 0xffc56e;
  if (["part_of", "same_project", "same_entity"].includes(relationType)) return 0x7df0bd;
  if (relationType === "similar_to") return 0xc797ff;
  if (relationType === "temporal") return 0x82b7ff;
  return 0x7ce9ff;
}

function buildSynapticDust(count: number) {
  const random = mulberry32(20231129);
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const direction = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 2 - 1,
    ).normalize();
    const radius = 14 + Math.cbrt(random()) * (SHELL_RADIUS - 17);
    positions.set([direction.x * radius, direction.y * radius, direction.z * radius], index * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color: 0xb8e6f1,
      size: 0.7,
      transparent: true,
      opacity: 0.34,
      sizeAttenuation: true,
      depthWrite: false,
    }),
  );
}

function buildGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Texture();
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.14, "rgba(255, 255, 255, 0.84)");
  gradient.addColorStop(0.46, "rgba(255, 255, 255, 0.2)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildShootingStar() {
  const points = 14;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points * 3), 3));
  const colors = new Float32Array(points * 3);
  for (let index = 0; index < points; index += 1) {
    const strength = index / (points - 1);
    colors.set([0.18 * strength, 0.72 * strength, strength], index * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.visible = false;
  return { line, points };
}

function updateShootingStar(star: ReturnType<typeof buildShootingStar>, progress: number) {
  const positions = star.line.geometry.getAttribute("position") as THREE.BufferAttribute;
  const head = new THREE.Vector3(
    130 - progress * 190,
    90 - progress * 90,
    -78 + progress * 8,
  );
  const trail = new THREE.Vector3(5.2, 2.5, -0.2);
  for (let index = 0; index < star.points; index += 1) {
    positions.setXYZ(
      index,
      head.x + trail.x * index,
      head.y + trail.y * index,
      head.z + trail.z * index,
    );
  }
  positions.needsUpdate = true;
  star.line.material.opacity = Math.sin(Math.PI * progress) * 0.82;
}

function drawLabels(
  context: CanvasRenderingContext2D | null,
  canvas: HTMLCanvasElement,
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  labelFocusPoint: THREE.Vector2,
  vaultGroup: THREE.Group,
  records: Map<string, NodeRecord>,
  selectedId: string | null,
) {
  if (!context) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, rect.width);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.textAlign = "center";
  context.textBaseline = "middle";

  vaultGroup.updateWorldMatrix(true, true);
  const projected = new THREE.Vector3();
  const worldPosition = new THREE.Vector3();
  const radiusPosition = new THREE.Vector3();
  const radiusProjected = new THREE.Vector3();
  const cameraUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  let focusedRecord: NodeRecord | null = null;
  let focusedDistance = Number.POSITIVE_INFINITY;
  let centeredRecord: NodeRecord | null = null;
  let centeredScore = Number.POSITIVE_INFINITY;

  for (const record of records.values()) {
    if (record.data.title.trim().toLowerCase() === PRIMARY_MEMORY_TITLE) continue;
    record.mesh.getWorldPosition(worldPosition);
    projected.copy(worldPosition).project(camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.15 || Math.abs(projected.y) > 1.15) {
      continue;
    }
    const worldRadius = record.mesh.geometry.parameters.radius * record.mesh.scale.x;
    radiusPosition.copy(worldPosition).addScaledVector(cameraUp, worldRadius);
    radiusProjected.copy(radiusPosition).project(camera);
    const pixelRadius = Math.abs(radiusProjected.y - projected.y) * rect.height * 0.5;
    if (pixelRadius < LABEL_REVEAL_RADIUS_PX) continue;
    const screenX = ((projected.x + 1) / 2) * rect.width;
    const screenY = ((1 - projected.y) / 2) * rect.height;
    const centerDistance = Math.hypot(screenX - rect.width / 2, screenY - rect.height / 2);
    const centerScore = centerDistance / pixelRadius;
    if (centerScore < centeredScore) {
      centeredRecord = record;
      centeredScore = centerScore;
    }
    const focusDistance = Math.hypot(screenX - labelFocusPoint.x, screenY - labelFocusPoint.y);
    const focusRadius = Math.max(LABEL_FOCUS_MIN_RADIUS_PX, pixelRadius * 1.5);
    if (focusDistance <= focusRadius && focusDistance < focusedDistance) {
      focusedRecord = record;
      focusedDistance = focusDistance;
    }
  }
  focusedRecord ??= centeredRecord;

  for (const record of records.values()) {
    // Keep the identity anchor readable at every scale; reveal only the one node
    // that is visually enlarged by zoom so dense graphs never become label walls.
    const isPrimaryMemory = record.data.title.trim().toLowerCase() === PRIMARY_MEMORY_TITLE;
    if (!isPrimaryMemory && record !== focusedRecord) continue;
    record.mesh.getWorldPosition(projected).project(camera);
    if (projected.z > 1) continue;
    const x = ((projected.x + 1) / 2) * rect.width;
    const y = ((1 - projected.y) / 2) * rect.height;
    const selected = record.data.id === selectedId;
    const lines = titleLines(record.data.title);
    context.font = `${selected ? 600 : 500} ${selected ? 12 : 10}px Inter, sans-serif`;
    const width = Math.max(...lines.map((line) => context.measureText(line).width)) + 18;
    const height = lines.length * 15 + 12;
    context.fillStyle = selected ? "rgba(1, 13, 22, 0.84)" : "rgba(1, 10, 18, 0.68)";
    context.strokeStyle = selected ? "rgba(103, 232, 255, 0.82)" : "rgba(54, 155, 190, 0.48)";
    context.lineWidth = selected ? 1 : 0.75;
    roundedRect(context, x - width / 2, y + 17, width, height, 5);
    context.fill();
    context.stroke();
    context.fillStyle = selected ? "#effdff" : "#a9c9d7";
    for (let index = 0; index < lines.length; index += 1) {
      context.fillText(lines[index], x, y + 17 + 8 + index * 15);
    }
  }
}

type MemoryCluster = { color: number; anchor: readonly [number, number, number] };

const MEMORY_CLUSTERS: Record<string, MemoryCluster> = {
  identity: { color: 0xd87bff, anchor: [37, 9, 19] },
  people: { color: 0xbc73ef, anchor: [48, -24, -8] },
  work: { color: 0x71c8ff, anchor: [-35, -24, 18] },
  places: { color: 0x69ddbf, anchor: [-43, 18, -7] },
  ideas: { color: 0xe7b774, anchor: [1, 38, -24] },
  life: { color: 0xf47f70, anchor: [3, -44, -16] },
};

function clusterForMemory(memory: MemoryGraphNode) {
  const searchable = `${memory.title} ${memory.tags.join(" ")}`.toLowerCase();
  if (/identity|personal|about|myself|profile|exampleUser/.test(searchable)) return MEMORY_CLUSTERS.identity;
  if (/person|people|family|friend|contact|relationship/.test(searchable)) return MEMORY_CLUSTERS.people;
  if (/work|career|software|engineer|project|company|business/.test(searchable)) return MEMORY_CLUSTERS.work;
  if (/place|location|city|country|travel|istanbul|london/.test(searchable)) return MEMORY_CLUSTERS.places;
  if (/idea|concept|learn|research|knowledge|book/.test(searchable)) return MEMORY_CLUSTERS.ideas;
  return MEMORY_CLUSTERS.life;
}

function clusterNodePosition(memory: MemoryGraphNode, index: number) {
  const cluster = clusterForMemory(memory);
  const random = mulberry32(hashString(memory.id) + index * 97);
  const offset = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1)
    .normalize()
    .multiplyScalar(4 + random() * 17);
  return new THREE.Vector3(...cluster.anchor).add(offset);
}

function tickClusterLayout(
  records: Map<string, NodeRecord>,
  edges: EdgeRecord[],
  deltaSeconds: number,
  reducedMotion: boolean,
) {
  if (reducedMotion || records.size === 0) return;
  const nodes = [...records.values()];
  const step = Math.min(deltaSeconds, 1 / 30) * 60;
  const delta = new THREE.Vector3();

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (left.dragging) continue;
    const anchorStrength = left.manuallyPlaced ? 0.013 : 0.022;
    left.velocity.addScaledVector(delta.copy(left.anchor).sub(left.mesh.position), anchorStrength * step);
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      delta.copy(left.mesh.position).sub(right.mesh.position);
      const distanceSquared = Math.max(18, delta.lengthSq());
      const force = (15 / distanceSquared) * step;
      delta.normalize().multiplyScalar(force);
      if (!left.dragging) left.velocity.add(delta);
      if (!right.dragging) right.velocity.sub(delta);
    }
  }

  for (const edge of edges) {
    delta.copy(edge.target.mesh.position).sub(edge.source.mesh.position);
    const distance = Math.max(0.001, delta.length());
    const spring = (distance - 31) * 0.0018 * step;
    delta.multiplyScalar(spring / distance);
    if (!edge.source.dragging) edge.source.velocity.add(delta);
    if (!edge.target.dragging) edge.target.velocity.sub(delta);
  }

  for (const record of nodes) {
    if (record.dragging) continue;
    record.velocity.multiplyScalar(Math.pow(0.82, step));
    record.mesh.position.addScaledVector(record.velocity, step);
    const radius = record.mesh.position.length();
    if (radius > SHELL_RADIUS - 10) record.mesh.position.setLength(SHELL_RADIUS - 10);
    if (radius < 15) record.mesh.position.setLength(15);
  }
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function titleLines(title: string) {
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && `${last} ${word}`.length <= 18) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.slice(0, 3);
}

function readSavedLayout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function savedPosition(saved: Record<string, unknown>, id: string) {
  const value = saved[id];
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => typeof item !== "number")) {
    return null;
  }
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function removeSavedPosition(id: string) {
  const saved = readSavedLayout();
  delete saved[id];
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Layout persistence is optional; the vault data remains untouched.
  }
}

function disposeChildren(group: THREE.Group) {
  for (const child of [...group.children]) {
    child.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!(object instanceof THREE.Sprite)) mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
    group.remove(child);
  }
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!(object instanceof THREE.Sprite)) mesh.geometry?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seededJitter(value: number) {
  return (Math.sin(value * 0.00137) + 1) / 2;
}
