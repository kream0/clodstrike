// Minimal three.js bootstrap proving the toolchain works.
// NOTE: this file is a placeholder and will be fully rewritten by the game layer.
import * as THREE from 'three';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app container');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb); // sky blue

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  1000,
);

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8a7a55, 1.2));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshLambertMaterial({ color: 0xb89b66 }), // sand
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// A few boxes so there is something to orbit around.
const boxMaterial = new THREE.MeshLambertMaterial({ color: 0xa08c5f });
const boxSpecs: [number, number, number, number][] = [
  // [x, z, footprint, height]
  [-8, -6, 2, 2],
  [6, -10, 3, 1.5],
  [10, 4, 2, 3],
  [-5, 8, 2.5, 2],
  [0, -14, 4, 2.5],
];
for (const [x, z, footprint, height] of boxSpecs) {
  const box = new THREE.Mesh(new THREE.BoxGeometry(footprint, height, footprint), boxMaterial);
  box.position.set(x, height / 2, z);
  scene.add(box);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const startTime = performance.now();
function frame(): void {
  const elapsed = (performance.now() - startTime) / 1000;
  const angle = elapsed * 0.15; // slow orbit
  camera.position.set(Math.sin(angle) * 26, 12, Math.cos(angle) * 26);
  camera.lookAt(0, 1, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

console.log('boot ok');
