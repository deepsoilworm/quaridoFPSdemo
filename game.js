import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// 게임 상태
const gameState = {
    currentRoom: null,
    rooms: new Map(), // 그리드 좌표 -> 방 정보
    playerPosition: { x: 0, y: 4 }, // 그리드 좌표 (최남단 가운데에서 시작)
    mapMode: false,
    nearDoor: null,
    pendingDoor: null,
    selectedRoomOption: null,
    openedDoors: new Set(), // 열린 문들 (문자열 키로 저장: "gridX,gridY,direction")
    doorPassageCheck: null // 문 통과 체크용
};

// 플레이어 상태
const playerState = {
    health: 100,
    maxHealth: 100,
    ammo: 30,
    maxAmmo: 30,
    canShoot: true,
    shootCooldown: 0
};

// 플레이어 총알 배열
const playerBullets = [];

// 7가지 방 타입 정의 (상대적 방향: 0=입구, 1=왼쪽, 2=뒤, 3=오른쪽)
const RoomTypes = {
    // 통로형 (3가지) - 입구(0) + 다른 방향 하나
    CORRIDOR_FRONT: { name: '통로형 (앞)', doors: [0, 2], type: 'corridor_front' }, // 입구 + 앞
    CORRIDOR_LEFT: { name: '통로형 (왼쪽)', doors: [0, 1], type: 'corridor_left' }, // 입구 + 왼쪽
    CORRIDOR_RIGHT: { name: '통로형 (오른쪽)', doors: [0, 3], type: 'corridor_right' }, // 입구 + 오른쪽
    // 삼거리형 (3가지) - 입구(0) + 다른 방향 두 개
    T_LEFT_FRONT: { name: '삼거리형 (왼쪽-앞)', doors: [0, 1, 2], type: 't_left_front' }, // 입구 + 왼쪽 + 앞
    T_FRONT_RIGHT: { name: '삼거리형 (앞-오른쪽)', doors: [0, 2, 3], type: 't_front_right' }, // 입구 + 앞 + 오른쪽
    T_RIGHT_LEFT: { name: '삼거리형 (오른쪽-왼쪽)', doors: [0, 3, 1], type: 't_right_left' }, // 입구 + 오른쪽 + 왼쪽
    // 사거리형 (1가지) - 모든 방향
    CROSSROAD: { name: '사거리형', doors: [0, 1, 2, 3], type: 'crossroad' }
};

// 방 크기 (20평 ≈ 66m², 약 8m x 8m)
const ROOM_SIZE = 8;
const WALL_HEIGHT = 3;
const DOOR_WIDTH = 1.5;

// 씬 설정
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);
scene.fog = new THREE.Fog(0x1a1a2e, 10, 50);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 0); // 플레이어 눈 높이

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.getElementById('gameContainer').appendChild(renderer.domElement);

// 조명
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
directionalLight.position.set(5, 10, 5);
directionalLight.castShadow = true;
scene.add(directionalLight);

// 컨트롤
const controls = new PointerLockControls(camera, renderer.domElement);

// 키보드 상태 (code 기반으로 변경하여 IME와 무관하게 작동)
const keys = {};
let isComposing = false; // IME 조합 상태 추적

// IME 조합 시작/종료 이벤트
document.addEventListener('compositionstart', () => {
    isComposing = true;
});

document.addEventListener('compositionend', () => {
    isComposing = false;
});

// e.code를 사용하여 물리적 키 위치를 기준으로 동작 (한국어 입력기와 무관)
document.addEventListener('keydown', (e) => {
    const keyCode = e.code;
    
    // 이동 키 (WASD) - code 기반으로 처리하여 IME와 무관하게 작동
    // IME 조합 중이 아닐 때만 처리
    if (!isComposing && !e.isComposing && (keyCode === 'KeyW' || keyCode === 'KeyS' || keyCode === 'KeyA' || keyCode === 'KeyD')) {
        keys[keyCode] = true;
        e.preventDefault(); // IME 입력 방지
        e.stopPropagation(); // 이벤트 전파 방지
    }
    
    // E키 - code와 key 모두 체크, IME 조합 중이 아닐 때만
    if (!isComposing && !e.isComposing && (keyCode === 'KeyE' || e.key.toLowerCase() === 'e')) {
        keys['KeyE'] = true;
        if (gameState.mapMode) {
            closeMap();
        } else if (document.getElementById('roomSelection').style.display === 'block') {
            // 방 선택 중이면 무시
            return;
        } else if (gameState.nearDoor) {
            openDoor(gameState.nearDoor);
        } else {
            openMap();
        }
        e.preventDefault();
        e.stopPropagation();
    }
    
    // ESC키
    if (keyCode === 'Escape' || e.key === 'Escape') {
        if (gameState.mapMode) {
            closeMap();
        } else {
            const selectionDiv = document.getElementById('roomSelection');
            if (selectionDiv && selectionDiv.style.display === 'block') {
                // 방 선택 UI 닫기
                selectionDiv.style.display = 'none';
                gameState.pendingDoor = null;
                gameState.selectedRoomOption = null;
                // 컨트롤 잠금 시도
                try {
                    controls.lock();
                } catch (e) {
                    setTimeout(() => {
                        try {
                            controls.lock();
                        } catch (e2) {
                            // 재시도 실패 시 무시
                        }
                    }, 100);
                }
            } else {
                controls.unlock();
            }
        }
    }
    
    // 마우스 클릭으로 발사 (왼쪽 클릭)
    if (keyCode === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!gameState.mapMode && controls.isLocked && playerState.canShoot && playerState.ammo > 0) {
            shootPlayerBullet();
        }
    }
}, true); // capture phase에서도 처리

document.addEventListener('keyup', (e) => {
    const keyCode = e.code;
    
    // 이동 키 해제 (IME 조합 중이 아닐 때만)
    if (!isComposing && !e.isComposing && (keyCode === 'KeyW' || keyCode === 'KeyS' || keyCode === 'KeyA' || keyCode === 'KeyD')) {
        keys[keyCode] = false;
    }
    
    if (!isComposing && !e.isComposing && keyCode === 'KeyE') {
        keys['KeyE'] = false;
    }
}, true); // capture phase에서도 처리

// 마우스 클릭으로 포인터 잠금 및 발사
renderer.domElement.addEventListener('click', (e) => {
    if (!gameState.mapMode) {
        if (controls.isLocked && playerState.canShoot && playerState.ammo > 0) {
            shootPlayerBullet();
        } else {
            controls.lock();
        }
    }
});

// 방 생성 함수
function createRoom(gridX, gridY, roomType, doors) {
    const roomGroup = new THREE.Group();
    
    // 바닥
    const floorGeometry = new THREE.PlaneGeometry(ROOM_SIZE, ROOM_SIZE);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x4a4a6a,
        roughness: 0.8
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    roomGroup.add(floor);
    
    // 천장
    const ceiling = floor.clone();
    ceiling.position.y = WALL_HEIGHT;
    ceiling.rotation.x = Math.PI / 2;
    roomGroup.add(ceiling);
    
    // 벽 생성 (북, 동, 남, 서)
    const wallPositions = [
        { pos: [0, WALL_HEIGHT/2, -ROOM_SIZE/2], rot: [0, 0, 0] }, // 북
        { pos: [ROOM_SIZE/2, WALL_HEIGHT/2, 0], rot: [0, Math.PI/2, 0] }, // 동
        { pos: [0, WALL_HEIGHT/2, ROOM_SIZE/2], rot: [0, Math.PI, 0] }, // 남
        { pos: [-ROOM_SIZE/2, WALL_HEIGHT/2, 0], rot: [0, -Math.PI/2, 0] } // 서
    ];
    
    const wallGeometry = new THREE.BoxGeometry(ROOM_SIZE, WALL_HEIGHT, 0.2);
    const wallMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x3a3a5a,
        roughness: 0.7
    });
    
    for (let i = 0; i < 4; i++) {
        const hasDoor = doors.includes(i);
        
        // 그리드 범위 체크 - 그리드를 벗어나는 방향에는 문을 만들지 않음
        const targetGrid = getTargetGrid(gridX, gridY, i);
        if (targetGrid.x < -2 || targetGrid.x > 2 || targetGrid.y < -4 || targetGrid.y > 4) {
            // 그리드 범위를 벗어나면 벽으로 처리
            const wall = new THREE.Mesh(wallGeometry, wallMaterial);
            wall.position.set(...wallPositions[i].pos);
            wall.rotation.set(...wallPositions[i].rot);
            wall.castShadow = true;
            roomGroup.add(wall);
            continue;
        }
        
        if (hasDoor) {
            // 문이 있는 경우, 벽을 두 부분으로 나눔
            const wallWidth = (ROOM_SIZE - DOOR_WIDTH) / 2;
            
            // 왼쪽 벽
            if (wallWidth > 0.1) {
                const leftWall = new THREE.Mesh(wallGeometry, wallMaterial);
                leftWall.scale.x = wallWidth / ROOM_SIZE;
                leftWall.position.set(
                    wallPositions[i].pos[0] - (DOOR_WIDTH / 2 + wallWidth / 2) * (i % 2 === 0 ? 1 : 0),
                    wallPositions[i].pos[1],
                    wallPositions[i].pos[2] - (DOOR_WIDTH / 2 + wallWidth / 2) * (i % 2 === 1 ? 1 : 0)
                );
                leftWall.rotation.set(...wallPositions[i].rot);
                leftWall.castShadow = true;
                roomGroup.add(leftWall);
            }
            
            // 오른쪽 벽
            if (wallWidth > 0.1) {
                const rightWall = new THREE.Mesh(wallGeometry, wallMaterial);
                rightWall.scale.x = wallWidth / ROOM_SIZE;
                rightWall.position.set(
                    wallPositions[i].pos[0] + (DOOR_WIDTH / 2 + wallWidth / 2) * (i % 2 === 0 ? 1 : 0),
                    wallPositions[i].pos[1],
                    wallPositions[i].pos[2] + (DOOR_WIDTH / 2 + wallWidth / 2) * (i % 2 === 1 ? 1 : 0)
                );
                rightWall.rotation.set(...wallPositions[i].rot);
                rightWall.castShadow = true;
                roomGroup.add(rightWall);
            }
            
            // 문 프레임
            // BoxGeometry는 (width, height, depth) 순서
            // 동서(1,3): 회전 후 depth가 x축 방향
            // 남북(0,2): 회전 후 depth가 z축 방향
            // 방향에 따라 geometry 크기를 다르게 설정해야 할 수도 있지만, 
            // 현재는 모든 방향에서 동일한 크기 사용 (회전으로 처리)
            const doorFrameGeometry = new THREE.BoxGeometry(DOOR_WIDTH, WALL_HEIGHT, 0.1);
            const doorFrameMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2a4a });
            const doorFrame = new THREE.Mesh(doorFrameGeometry, doorFrameMaterial);
            doorFrame.position.set(...wallPositions[i].pos);
            doorFrame.rotation.set(...wallPositions[i].rot);
            // 문 프레임의 실제 월드 위치를 userData에 저장 (제거 시 사용)
            doorFrame.userData = { 
                isDoorFrame: true, 
                doorDirection: i,
                originalPosition: [...wallPositions[i].pos],
                originalRotation: [...wallPositions[i].rot]
            };
            roomGroup.add(doorFrame);
            
            // 문 (상호작용 가능)
            const doorGeometry = new THREE.PlaneGeometry(DOOR_WIDTH, WALL_HEIGHT - 0.2);
            const doorMaterial = new THREE.MeshStandardMaterial({ 
                color: 0x5a4a3a,
                side: THREE.DoubleSide
            });
            const door = new THREE.Mesh(doorGeometry, doorMaterial);
            door.position.set(...wallPositions[i].pos);
            door.position.y = (WALL_HEIGHT - 0.2) / 2;
            door.rotation.set(...wallPositions[i].rot);
            door.userData = {
                isDoor: true,
                direction: i,
                gridX: gridX,
                gridY: gridY,
                targetGrid: getTargetGrid(gridX, gridY, i),
                doorFrame: doorFrame
            };
            roomGroup.add(door);
        } else {
            // 문이 없는 경우, 전체 벽
            const wall = new THREE.Mesh(wallGeometry, wallMaterial);
            wall.position.set(...wallPositions[i].pos);
            wall.rotation.set(...wallPositions[i].rot);
            wall.castShadow = true;
            roomGroup.add(wall);
        }
    }
    
    // 조명 추가
    const roomLight = new THREE.PointLight(0xffffff, 0.8, 10);
    roomLight.position.set(0, WALL_HEIGHT - 0.5, 0);
    roomGroup.add(roomLight);
    
    // 그리드 y축을 Three.js z축에 매핑
    // y=-4 (그리드 최북단, 미니맵 최상) → z=-32 (Three.js 북쪽)
    // y=4 (그리드 최남단, 미니맵 최하) → z=32 (Three.js 남쪽)
    // 따라서: 그리드 y가 작을수록 = Three.js z가 작을수록 = 북쪽
    roomGroup.position.set(gridX * ROOM_SIZE, 0, gridY * ROOM_SIZE);
    
    return {
        group: roomGroup,
        type: roomType,
        doors: doors,
        gridX: gridX,
        gridY: gridY,
        generated: true
    };
}

// 목표 그리드 계산
// 그리드 y축을 Three.js z축에 매핑:
// roomGroup.position.set(gridX * ROOM_SIZE, 0, gridY * ROOM_SIZE)
// gridY = -4 → z = -32 (작음, Three.js에서 북쪽) = 미니맵 최상 (최북단)
// gridY = 4 → z = 32 (큼, Three.js에서 남쪽) = 미니맵 최하 (최남단)
// 따라서: 그리드 y가 작을수록 = Three.js z가 작을수록 = 북쪽
// - 북쪽(0)으로 가면: z 감소 = 그리드 y 감소
// - 남쪽(2)으로 가면: z 증가 = 그리드 y 증가
function getTargetGrid(gridX, gridY, direction) {
    // 방향 확인: direction 0 = 북쪽 벽, Three.js에서 z가 작을수록 북쪽
    // 그리드 y=-4는 z=-32 (북쪽), y=4는 z=32 (남쪽)
    // 테스트를 위해 방향을 일시적으로 확인
    const directions = [
        { x: 0, y: -1 }, // 북: y 감소 (그리드 최북단으로) = z 감소 (Three.js 북쪽)
        { x: 1, y: 0 },  // 동: x 증가 (동쪽)
        { x: 0, y: 1 },  // 남: y 증가 (그리드 최남단으로) = z 증가 (Three.js 남쪽)
        { x: -1, y: 0 }  // 서: x 감소 (서쪽)
    ];
    const dir = directions[direction];
    const result = { x: gridX + dir.x, y: gridY + dir.y };
    console.log(`getTargetGrid: (${gridX}, ${gridY}) direction ${direction} → (${result.x}, ${result.y})`);
    return result;
}

// 3가지 방 타입 랜덤 선택 (입구는 항상 0이므로 모든 타입 사용 가능)
function selectThreeRoomTypes(entranceDirection) {
    const allTypes = Object.values(RoomTypes);
    const selected = [];
    const indices = new Set();
    
    while (selected.length < 3 && indices.size < allTypes.length) {
        const idx = Math.floor(Math.random() * allTypes.length);
        if (!indices.has(idx)) {
            indices.add(idx);
            selected.push(allTypes[idx]);
        }
    }
    
    // 3개가 안되면 반복해서 채우기
    while (selected.length < 3) {
        const idx = Math.floor(Math.random() * allTypes.length);
        selected.push(allTypes[idx]);
    }
    
    return selected.slice(0, 3);
}

// 상대적 방향을 절대적 방향으로 변환 (입구 방향 기준)
// relativeDir: 0=입구, 1=왼쪽, 2=뒤, 3=오른쪽
// entranceAbsoluteDir: 절대 방향 (0=북, 1=동, 2=남, 3=서)
// 플레이어가 입구 방향을 바라볼 때: 왼쪽은 반시계 방향, 오른쪽은 시계 방향
// Three.js 좌표계: z축이 앞뒤, x축이 좌우 (오른쪽이 +x)
// 절대 방향: 0=북(-z), 1=동(+x), 2=남(+z), 3=서(-x)
function relativeToAbsolute(relativeDir, entranceAbsoluteDir) {
    // 입구 방향을 기준으로 회전
    // 플레이어가 입구 방향을 바라볼 때:
    // - 왼쪽(1): 입구에서 반시계 방향 90도 = 시계 방향으로 3칸
    // - 뒤(2): 입구에서 180도 반대
    // - 오른쪽(3): 입구에서 시계 방향 90도 = 시계 방향으로 1칸
    
    if (relativeDir === 0) {
        return entranceAbsoluteDir; // 입구는 그대로
    } else if (relativeDir === 1) {
        // 왼쪽: 시계 방향으로 1칸 (반대로 되어 있었음)
        return (entranceAbsoluteDir + 1) % 4;
    } else if (relativeDir === 2) {
        // 뒤: 180도 반대
        return (entranceAbsoluteDir + 2) % 4;
    } else if (relativeDir === 3) {
        // 오른쪽: 반시계 방향 = 시계 방향으로 3칸 (반대로 되어 있었음)
        return (entranceAbsoluteDir + 3) % 4;
    }
    return entranceAbsoluteDir;
}

// 전체 5x9 그리드의 빈 방 미리 생성
function createAllGridRooms() {
    // 5x9 그리드: x: -2~2, y: -4~4
    for (let x = -2; x <= 2; x++) {
        for (let y = -4; y <= 4; y++) {
            const gridKey = `${x},${y}`;
            if (!gameState.rooms.has(gridKey)) {
                // 빈 방 생성 (아직 결정되지 않은 상태)
                // 나중에 문을 열 때 실제 방 타입이 결정됨
                // 일단은 보이지 않는 빈 공간으로 생성
                const emptyRoom = {
                    group: new THREE.Group(),
                    type: 'empty',
                    doors: [],
                    gridX: x,
                    gridY: y,
                    generated: false
                };
                gameState.rooms.set(gridKey, emptyRoom);
            }
        }
    }
}

// 시작 방 생성 (최남단 가운데: x=0, y=4)
function createStartRoom() {
    // 전체 그리드 방 미리 생성
    createAllGridRooms();
    
    const startX = 0; // 가운데
    const startY = 4; // 최남단 (5x9 그리드에서)
    const doors = [3, 0, 1]; // 서(왼쪽), 북(앞), 동(오른쪽)에 문
    const room = createRoom(startX, startY, 'start', doors);
    gameState.rooms.set(`${startX},${startY}`, room);
    scene.add(room.group);
    gameState.currentRoom = room;
    gameState.playerPosition = { x: startX, y: startY };
    
    // 플레이어를 방 중앙에 배치
    // 그리드 y=4 → Three.js z=32 (남쪽 위치, 최남단)
    camera.position.set(startX * ROOM_SIZE, 1.6, startY * ROOM_SIZE);
    
    // 카메라를 북쪽(-z 방향)을 바라보도록 설정
    // Three.js에서 북쪽은 -z 방향이므로 lookAt으로 설정
    camera.lookAt(startX * ROOM_SIZE, 1.6, startY * ROOM_SIZE - 1);
    
    // 초기 미니맵 그리기
    drawMinimap();
}

// 목표 방 생성 (임시로 먼 곳에 배치)
function createGoalRoom(gridX, gridY) {
    const doors = [0, 1, 2]; // 북, 동, 남에 문
    const room = createRoom(gridX, gridY, 'goal', doors);
    gameState.rooms.set(`${gridX},${gridY}`, room);
    scene.add(room.group);
    
    // 목표 방 표시를 위한 특별한 조명
    const goalLight = new THREE.PointLight(0xffd700, 1, 15);
    goalLight.position.set(gridX * ROOM_SIZE, WALL_HEIGHT, gridY * ROOM_SIZE);
    scene.add(goalLight);
}

// 문 열기 - 방 선택 UI 표시 (E키로 호출)
function openDoor(door) {
    const targetGrid = door.userData.targetGrid;
    const targetKey = `${targetGrid.x},${targetGrid.y}`;
    const targetRoom = gameState.rooms.get(targetKey);
    
    // 이미 생성된 방인지 확인
    if (targetRoom && targetRoom.generated) {
        // 이미 생성된 방이면 E키 없이 자동으로 열려야 함
        // 여기서는 아무것도 하지 않음 (updateDoorDetection에서 처리)
        return;
    }
    
    // 새 방 생성 전에 선택 UI 표시
    gameState.pendingDoor = door;
    const entranceDirection = (door.userData.direction + 2) % 4; // 반대 방향
    const roomOptions = selectThreeRoomTypes(entranceDirection);
    
    showRoomSelection(roomOptions, entranceDirection);
}

// 방 선택 UI 표시
function showRoomSelection(roomOptions, entranceDirection) {
    const selectionDiv = document.getElementById('roomSelection');
    const optionsDiv = document.getElementById('roomOptions');
    const confirmBtn = document.getElementById('confirmRoom');
    
    optionsDiv.innerHTML = '';
    gameState.selectedRoomOption = null;
    confirmBtn.disabled = true;
    
    roomOptions.forEach((roomType, index) => {
        const optionDiv = document.createElement('div');
        optionDiv.className = 'room-option';
        
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'roomType';
        radio.value = index;
        radio.id = `roomOption${index}`;
        radio.addEventListener('change', () => {
            gameState.selectedRoomOption = roomType;
            confirmBtn.disabled = false;
        });
        
        const preview = document.createElement('canvas');
        preview.className = 'room-preview';
        drawRoomPreview(preview, roomType.doors);
        
        const info = document.createElement('div');
        info.className = 'room-info';
        const title = document.createElement('h4');
        title.textContent = roomType.name;
        const desc = document.createElement('p');
        desc.textContent = `문 ${roomType.doors.length}개`;
        info.appendChild(title);
        info.appendChild(desc);
        
        optionDiv.appendChild(radio);
        optionDiv.appendChild(preview);
        optionDiv.appendChild(info);
        optionsDiv.appendChild(optionDiv);
    });
    
    confirmBtn.onclick = () => {
        if (gameState.selectedRoomOption && gameState.pendingDoor) {
            createSelectedRoom();
        } else {
            // 조건이 맞지 않으면 UI 닫기
            const selectionDiv = document.getElementById('roomSelection');
            if (selectionDiv) {
                selectionDiv.style.display = 'none';
            }
            gameState.pendingDoor = null;
            gameState.selectedRoomOption = null;
            try {
                controls.lock();
            } catch (e) {
                setTimeout(() => {
                    try {
                        controls.lock();
                    } catch (e2) {
                        // 재시도 실패 시 무시
                    }
                }, 100);
            }
        }
    };
    
    selectionDiv.style.display = 'block';
    controls.unlock();
}

// 방 미리보기 그리기 (상대적 방향: 0=입구(아래), 1=왼쪽, 2=뒤(위), 3=오른쪽)
function drawRoomPreview(canvas, doors) {
    canvas.width = 80;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    
    const size = 80;
    const padding = 5;
    const roomSize = size - padding * 2;
    
    // 배경
    ctx.fillStyle = '#4a4a6a';
    ctx.fillRect(padding, padding, roomSize, roomSize);
    
    // 문 표시 (상대적 방향)
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    
    // 상대적 방향 위치: 0=입구(아래), 1=왼쪽, 2=뒤(위), 3=오른쪽
    const doorPositions = [
        { x: size / 2, y: size - padding, len: roomSize / 3 }, // 0: 입구 (아래)
        { x: padding, y: size / 2, len: roomSize / 3 }, // 1: 왼쪽
        { x: size / 2, y: padding, len: roomSize / 3 }, // 2: 뒤 (위)
        { x: size - padding, y: size / 2, len: roomSize / 3 } // 3: 오른쪽
    ];
    
    doors.forEach((doorDir) => {
        const pos = doorPositions[doorDir];
        ctx.beginPath();
        if (doorDir === 0 || doorDir === 2) {
            // 입구/뒤 (수평)
            ctx.moveTo(pos.x - pos.len, pos.y);
            ctx.lineTo(pos.x + pos.len, pos.y);
        } else {
            // 왼쪽/오른쪽 (수직)
            ctx.moveTo(pos.x, pos.y - pos.len);
            ctx.lineTo(pos.x, pos.y + pos.len);
        }
        ctx.stroke();
    });
    
    // 입구 표시 (화살표)
    if (doors.includes(0)) {
        ctx.fillStyle = '#4a9a4a';
        ctx.beginPath();
        ctx.moveTo(size / 2, size - padding - 5);
        ctx.lineTo(size / 2 - 5, size - padding - 15);
        ctx.lineTo(size / 2 + 5, size - padding - 15);
        ctx.closePath();
        ctx.fill();
    }
}

// 선택된 방 생성
function createSelectedRoom() {
    // 항상 UI를 닫도록 finally 블록 사용
    try {
        if (!gameState.selectedRoomOption || !gameState.pendingDoor) {
            // UI 닫기
            const selectionDiv = document.getElementById('roomSelection');
            selectionDiv.style.display = 'none';
            controls.lock();
            return;
        }
        
        const door = gameState.pendingDoor;
        const targetGrid = door.userData.targetGrid;
        const targetKey = `${targetGrid.x},${targetGrid.y}`;
        
        // 디버깅: 문 방향과 타겟 그리드 확인
        const directionNames = ['북', '동', '남', '서'];
        console.log('현재 방:', door.userData.gridX, door.userData.gridY, '문 방향:', directionNames[door.userData.direction], '타겟 그리드:', targetGrid);
        
        // 기존 빈 방이 있으면 제거
        const existingRoom = gameState.rooms.get(targetKey);
        if (existingRoom && existingRoom.group) {
            scene.remove(existingRoom.group);
        }
        
        // 입구 절대 방향 (들어온 문의 반대 방향)
        const entranceAbsoluteDir = (door.userData.direction + 2) % 4;
        console.log('새 방 입구 방향:', directionNames[entranceAbsoluteDir], '새 방 위치:', targetGrid.x, targetGrid.y);
        
        // 상대적 방향을 절대적 방향으로 변환
        const relativeDoors = gameState.selectedRoomOption.doors; // [0, 1, 2] 같은 상대적 방향
        let absoluteDoors = relativeDoors.map(relDir => relativeToAbsolute(relDir, entranceAbsoluteDir));
        
        // 입구(0)는 항상 entranceAbsoluteDir로 변환되어야 함
        if (!absoluteDoors.includes(entranceAbsoluteDir)) {
            absoluteDoors.push(entranceAbsoluteDir);
        }
        
        // 그리드 범위를 벗어나는 방향의 문을 필터링
        // y=-4는 맨 아래, y=4는 맨 위이므로 범위를 벗어나는 방향의 문은 생성하면 안 됨
        absoluteDoors = absoluteDoors.filter((doorDir) => {
            const testTargetGrid = getTargetGrid(targetGrid.x, targetGrid.y, doorDir);
            // 그리드 범위 내에 있는지 확인 (5x9: x: -2~2, y: -4~4)
            const inRange = testTargetGrid.x >= -2 && testTargetGrid.x <= 2 && 
                           testTargetGrid.y >= -4 && testTargetGrid.y <= 4;
            if (!inRange) {
                console.log(`그리드 범위를 벗어나는 문 제거: 방향 ${directionNames[doorDir]}, 타겟 그리드 (${testTargetGrid.x}, ${testTargetGrid.y})`);
            }
            return inRange;
        });
        
        // 입구가 필터링되어 제거되었으면 다시 추가 (입구는 반드시 있어야 함)
        if (!absoluteDoors.includes(entranceAbsoluteDir)) {
            absoluteDoors.push(entranceAbsoluteDir);
        }
        
        const newRoom = createRoom(
            targetGrid.x, 
            targetGrid.y, 
            gameState.selectedRoomOption.type, 
            absoluteDoors
        );
        
        // newRoom이 제대로 생성되었는지 확인
        if (!newRoom || !newRoom.group) {
            console.error('방 생성 실패:', targetGrid);
            // UI 닫기
            const selectionDiv = document.getElementById('roomSelection');
            if (selectionDiv) {
                selectionDiv.style.display = 'none';
            }
            gameState.pendingDoor = null;
            gameState.selectedRoomOption = null;
            try {
                controls.lock();
            } catch (e) {
                setTimeout(() => {
                    try {
                        controls.lock();
                    } catch (e2) {
                        // 재시도 실패 시 무시
                    }
                }, 100);
            }
            return;
        }
        
        gameState.rooms.set(targetKey, newRoom);
        scene.add(newRoom.group);
        
        // 목표 방인지 확인 (임시로 (3, 0)에 배치)
        if (targetGrid.x === 3 && targetGrid.y === 0) {
            createGoalRoom(3, 0);
        }
        
        // 문 완전히 제거
        removeDoorCompletely(door);
        
        // 문 통과 체크 시작
        const doorKey = `${door.userData.gridX},${door.userData.gridY},${door.userData.direction}`;
        gameState.openedDoors.add(doorKey);
        
        // 반대편 문도 열어두기 (양방향 통과 가능)
        const oppositeDoorKey = `${targetGrid.x},${targetGrid.y},${entranceAbsoluteDir}`;
        gameState.openedDoors.add(oppositeDoorKey);
        
        // 반대편 방의 문도 완전히 제거 (방금 생성한 newRoom 사용)
        // traverse를 사용하여 모든 문과 문 프레임을 찾아서 제거
        const doorsToRemove = [];
        const doorFramesToRemove = new Set(); // 중복 제거를 위해 Set 사용
        
        newRoom.group.traverse((child) => {
            if (child.userData) {
                // 문 찾기
                if (child.userData.isDoor && child.userData.direction === entranceAbsoluteDir) {
                    doorsToRemove.push(child);
                    // 문의 doorFrame도 함께 추가
                    if (child.userData.doorFrame) {
                        doorFramesToRemove.add(child.userData.doorFrame);
                    }
                }
                // 문 프레임 찾기 (문과 별도로 찾아야 함)
                if (child.userData.isDoorFrame && child.userData.doorDirection === entranceAbsoluteDir) {
                    doorFramesToRemove.add(child);
                }
            }
        });
        
        // 찾은 문들을 모두 제거
        doorsToRemove.forEach(doorToRemove => {
            removeDoorCompletely(doorToRemove);
        });
        
        // 문 프레임도 별도로 제거 (문과 별도로 제거해야 함)
        doorFramesToRemove.forEach(frameToRemove => {
            if (frameToRemove && frameToRemove.parent) {
                frameToRemove.parent.remove(frameToRemove);
            }
        });
        
        // 디버깅: 제거된 문 확인
        console.log('제거할 문 방향:', directionNames[entranceAbsoluteDir], '찾은 문 개수:', doorsToRemove.length, '문 프레임 개수:', doorFramesToRemove.size);
        
        // 미니맵 업데이트
        drawMinimap();
        
        gameState.pendingDoor = null;
        gameState.selectedRoomOption = null;
        
        // UI 닫기 (성공한 경우에도 여기서 닫기)
        const selectionDiv = document.getElementById('roomSelection');
        if (selectionDiv) {
            selectionDiv.style.display = 'none';
        }
    } catch (error) {
        console.error('방 생성 중 오류:', error);
    } finally {
        // 항상 UI를 닫고 컨트롤을 다시 활성화 (에러가 발생해도 실행됨)
        const selectionDiv = document.getElementById('roomSelection');
        if (selectionDiv) {
            selectionDiv.style.display = 'none';
        }
        // 컨트롤 잠금을 시도하고, 실패하면 재시도
        try {
            controls.lock();
        } catch (e) {
            // 포인터 잠금이 실패하면 약간의 지연 후 재시도
            setTimeout(() => {
                try {
                    controls.lock();
                } catch (e2) {
                    // 재시도 실패 시 무시
                }
            }, 100);
        }
    }
}

// 문 즉시 제거 (새 방 생성 시 - 애니메이션 없음)
function openDoorAnimation(door) {
    // 문을 즉시 제거 (애니메이션 없음)
    const doorMesh = door;
    const doorFrame = door.userData.doorFrame;
    
    // 문과 프레임을 즉시 숨김
    if (doorMesh) {
        doorMesh.visible = false;
        if (doorMesh.material) {
            doorMesh.material.opacity = 0;
            doorMesh.material.transparent = true;
        }
    }
    if (doorFrame) {
        doorFrame.visible = false;
        if (doorFrame.material) {
            doorFrame.material.opacity = 0;
            doorFrame.material.transparent = true;
        }
    }
}

// 문 완전히 제거 (지나온 방용 - 문과 프레임 모두 제거)
function removeDoorCompletely(door) {
    const doorMesh = door;
    const doorFrame = door.userData.doorFrame;
    
    // 문과 프레임을 씬에서 완전히 제거
    if (doorMesh && doorMesh.parent) {
        doorMesh.parent.remove(doorMesh);
    }
    if (doorFrame && doorFrame.parent) {
        doorFrame.parent.remove(doorFrame);
    }
}

// 방으로 이동 (걸어서 이동하므로 카메라 위치는 그대로 유지)
function moveToRoom(gridX, gridY) {
    gameState.playerPosition = { x: gridX, y: gridY };
    gameState.currentRoom = gameState.rooms.get(`${gridX},${gridY}`);
    
    // 미니맵 업데이트
    drawMinimap();
    
    // doorPassageCheck 초기화
    gameState.doorPassageCheck = null;
    
    // 승리 조건 체크: 최북단 가운데 방(x=0, y=-4)에 도달했는지 확인
    if (gridX === 0 && gridY === -4) {
        showVictory();
    }
}

// 승리 UI 표시
function showVictory() {
    const victoryDiv = document.getElementById('victory');
    if (victoryDiv) {
        victoryDiv.style.display = 'flex';
        controls.unlock();
    }
}

// 문 감지
function checkNearDoor() {
    if (!gameState.currentRoom) return null;
    
    const playerWorldPos = new THREE.Vector3();
    camera.getWorldPosition(playerWorldPos);
    
    const roomGroup = gameState.currentRoom.group;
    let nearestDoor = null;
    let minDistance = Infinity;
    
    roomGroup.traverse((child) => {
        if (child.userData.isDoor) {
            const doorWorldPos = new THREE.Vector3();
            child.getWorldPosition(doorWorldPos);
            const distance = playerWorldPos.distanceTo(doorWorldPos);
            
            if (distance < 2 && distance < minDistance) {
                minDistance = distance;
                nearestDoor = child;
            }
        }
    });
    
    return nearestDoor;
}

// 맵 열기
function openMap() {
    gameState.mapMode = true;
    document.getElementById('mapOverlay').style.display = 'flex';
    controls.unlock();
    drawMap();
}

// 맵 닫기
function closeMap() {
    gameState.mapMode = false;
    document.getElementById('mapOverlay').style.display = 'none';
}

// 맵 그리기 (큰 맵)
function drawMap() {
    const canvas = document.getElementById('mapCanvas');
    drawMapToCanvas(canvas, 30, 50, true);
}

// 미니맵 그리기
function drawMinimap() {
    const canvas = document.getElementById('minimap');
    drawMapToCanvas(canvas, 15, 5, false);
}

// 맵을 캔버스에 그리기 (공통 함수)
function drawMapToCanvas(canvas, initialCellSize, padding, showLabels) {
    const ctx = canvas.getContext('2d');
    
    // 미니맵은 항상 고정된 5x9 그리드 표시 (x: -2~2, y: -4~4)
    let minX, maxX, minY, maxY;
    if (!showLabels) {
        // 미니맵: 고정된 5x9 그리드 (가로 5칸, 세로 9칸)
        minX = -2; // 왼쪽 끝
        maxX = 2;  // 오른쪽 끝
        minY = -4; // 맨 밑
        maxY = 4;  // 맨 위
    } else {
        // 큰 맵: 실제 방 범위
        minX = 0; maxX = 0; minY = 0; maxY = 0;
        gameState.rooms.forEach((room) => {
            minX = Math.min(minX, room.gridX);
            maxX = Math.max(maxX, room.gridX);
            minY = Math.min(minY, room.gridY);
            maxY = Math.max(maxY, room.gridY);
        });
    }
    
    const gridWidth = maxX - minX + 1;
    const gridHeight = maxY - minY + 1;
    
    // 미니맵은 고정 크기 (200x200)에 맞춰 셀 크기 조정
    let cellSize = initialCellSize;
    if (!showLabels) {
        const availableWidth = 200 - padding * 2;
        const availableHeight = 200 - padding * 2;
        cellSize = Math.min(
            Math.floor(availableWidth / gridWidth),
            Math.floor(availableHeight / gridHeight)
        );
        canvas.width = 200;
        canvas.height = 200;
    } else {
        canvas.width = gridWidth * cellSize + padding * 2;
        canvas.height = gridHeight * cellSize + padding * 2;
    }
    
    // 배경
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 그리드 그리기 (미니맵은 밝게)
    ctx.strokeStyle = showLabels ? '#444' : '#888'; // 미니맵은 밝게
    ctx.lineWidth = 1;
    for (let x = 0; x <= gridWidth; x++) {
        ctx.beginPath();
        ctx.moveTo(padding + x * cellSize, padding);
        ctx.lineTo(padding + x * cellSize, padding + gridHeight * cellSize);
        ctx.stroke();
    }
    for (let y = 0; y <= gridHeight; y++) {
        ctx.beginPath();
        ctx.moveTo(padding, padding + y * cellSize);
        ctx.lineTo(padding + gridWidth * cellSize, padding + y * cellSize);
        ctx.stroke();
    }
    
    // 모든 그리드 칸 그리기 (미니맵용)
    // y 좌표는 반대로 계산 (y=-4가 맨 위에 표시되도록)
    for (let gx = minX; gx <= maxX; gx++) {
        for (let gy = minY; gy <= maxY; gy++) {
            const x = (gx - minX) * cellSize + padding;
            const y = (gy - minY) * cellSize + padding; // y 좌표 정방향 (y=-4가 위에 표시)
            const gridKey = `${gx},${gy}`;
            const room = gameState.rooms.get(gridKey);
            
            if (room) {
                // 방이 생성된 경우
                let color = '#4a4a6a';
                if (room.type === 'start') color = '#4a9a4a';
                else if (room.type === 'goal') color = '#ffd700';
                else if (room.type.includes('corridor')) color = '#6a6a8a';
                else if (room.type.includes('t_')) color = '#7a7a9a';
                else if (room.type === 'crossroad') color = '#8a8aaa';
                
                ctx.fillStyle = color;
                ctx.fillRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
                
                // 문 표시
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = showLabels ? 2 : 1;
                room.doors.forEach((doorDir) => {
                    // 미니맵은 y 좌표가 정방향 (y=-4가 위쪽, 최북단)
                    // 그리드에서 y=-4는 최북단, y=4는 최남단
                    // 미니맵에서 y=-4는 화면상 위, y=4는 화면상 아래
                    // Three.js에서 direction 0 (북) = -z 방향 = y 감소
                    // Three.js에서 direction 2 (남) = +z 방향 = y 증가
                    // 따라서 direction 0 (북, y 감소) → 미니맵에서는 화면상 위쪽 (y)
                    // direction 2 (남, y 증가) → 미니맵에서는 화면상 아래쪽 (y + cellSize)
                    const doorPositions = [
                        { x: x + cellSize / 2, y: y, len: cellSize / 3 }, // 북 → 화면상 위
                        { x: x + cellSize, y: y + cellSize / 2, len: cellSize / 3 }, // 동
                        { x: x + cellSize / 2, y: y + cellSize, len: cellSize / 3 }, // 남 → 화면상 아래
                        { x: x, y: y + cellSize / 2, len: cellSize / 3 } // 서
                    ];
                    const pos = doorPositions[doorDir];
                    ctx.beginPath();
                    if (doorDir % 2 === 0) {
                        // 북/남
                        ctx.moveTo(pos.x - pos.len, pos.y);
                        ctx.lineTo(pos.x + pos.len, pos.y);
                    } else {
                        // 동/서
                        ctx.moveTo(pos.x, pos.y - pos.len);
                        ctx.lineTo(pos.x, pos.y + pos.len);
                    }
                    ctx.stroke();
                });
                
                // 방 타입 라벨 (큰 맵에만)
                if (showLabels) {
                    ctx.fillStyle = '#fff';
                    ctx.font = '10px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(room.type.substring(0, 4), x + cellSize / 2, y + cellSize / 2 + 3);
                }
            } else {
                // 방이 아직 생성되지 않은 경우 (미니맵에만 표시)
                if (!showLabels) {
                    ctx.fillStyle = '#2a2a3a';
                    ctx.fillRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
                    ctx.strokeStyle = '#444';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
                }
            }
        }
    }
    
    // 플레이어 위치 표시 (실시간 업데이트 - 방 안에서의 상대적 위치 포함)
    const currentRoom = gameState.currentRoom;
    let playerMapX, playerMapY;
    
    if (currentRoom && currentRoom.generated) {
        // 방 안에서의 상대적 위치 계산
        const roomGridX = currentRoom.gridX;
        const roomGridY = currentRoom.gridY;
        const roomCenterX = roomGridX * ROOM_SIZE;
        const roomCenterZ = roomGridY * ROOM_SIZE; // 그리드 y를 z에 매핑
        
        // 카메라의 실제 위치를 방 안에서의 상대적 위치로 변환 (-0.5 ~ 0.5 범위)
        const relativeX = (camera.position.x - roomCenterX) / ROOM_SIZE;
        const relativeZ = (camera.position.z - roomCenterZ) / ROOM_SIZE;
        
        // 방의 네모 위치 계산
        const roomMapX = (roomGridX - minX) * cellSize + padding;
        const roomMapY = (roomGridY - minY) * cellSize + padding; // y 좌표 정방향 (y=-4가 위)
        
        // 플레이어 위치를 방 네모 안에 상대적으로 표시
        // 그리드 y축과 Three.js z축이 일치:
        // Three.js z 증가 = 남쪽, 그리드 y 증가 = 남쪽
        // 미니맵에서 y=-4가 위(최북단), y=4가 아래(최남단)
        // Three.js에서 z가 작아지면(북쪽) relativeZ가 음수 → 미니맵에서는 위로 이동해야 함
        // Three.js에서 z가 커지면(남쪽) relativeZ가 양수 → 미니맵에서는 아래로 이동해야 함
        playerMapX = roomMapX + cellSize / 2 + relativeX * cellSize;
        playerMapY = roomMapY + cellSize / 2 + relativeZ * cellSize; // z와 y가 일치하므로 더함 (z 증가 = 남쪽 = 미니맵 아래)
    } else {
        // 방이 없으면 그리드 중심
        playerMapX = (gameState.playerPosition.x - minX) * cellSize + padding + cellSize / 2;
        playerMapY = (gameState.playerPosition.y - minY) * cellSize + padding + cellSize / 2; // y 좌표 정방향
    }
    
    // 플레이어가 그리드 범위 내에 있는지 확인
    if (playerMapX >= padding && playerMapX < canvas.width - padding && 
        playerMapY >= padding && playerMapY < canvas.height - padding) {
        // 빨간색 원으로 플레이어 위치 표시 (방 네모 안에)
        ctx.fillStyle = '#ff0000';
        ctx.beginPath();
        ctx.arc(playerMapX, playerMapY, showLabels ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
        
        // 플레이어 방향 표시 (카메라 방향)
        const cameraDirection = new THREE.Vector3();
        camera.getWorldDirection(cameraDirection);
        const angle = Math.atan2(cameraDirection.x, cameraDirection.z);
        
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playerMapX, playerMapY);
        ctx.lineTo(
            playerMapX + Math.sin(angle) * (cellSize / 3),
            playerMapY + Math.cos(angle) * (cellSize / 3)
        );
        ctx.stroke();
    }
    
    // AI 위치 표시 (ai.js가 로드되었고 AI가 존재하면)
    if (typeof window.aiState !== 'undefined' && window.aiState && window.aiState.mesh && !window.aiState.reached) {
        const aiPos = window.aiState.position;
        const aiMesh = window.aiState.mesh;
        
        if (aiPos) {
            // AI의 그리드 위치
            const aiGridX = aiPos.x;
            const aiGridY = aiPos.y;
            
            // AI가 현재 표시 범위 내에 있는지 확인
            if (aiGridX >= minX && aiGridX <= maxX && aiGridY >= minY && aiGridY <= maxY) {
                // AI 방의 네모 위치 계산
                const aiRoomMapX = (aiGridX - minX) * cellSize + padding;
                const aiRoomMapY = (aiGridY - minY) * cellSize + padding;
                
                // AI의 실제 월드 위치를 방 안에서의 상대적 위치로 변환
                const aiRoomCenterX = aiGridX * ROOM_SIZE;
                const aiRoomCenterZ = aiGridY * ROOM_SIZE;
                const relativeAIX = (aiMesh.position.x - aiRoomCenterX) / ROOM_SIZE;
                const relativeAIZ = (aiMesh.position.z - aiRoomCenterZ) / ROOM_SIZE;
                
                // AI 위치를 방 네모 안에 상대적으로 표시
                const aiMapX = aiRoomMapX + cellSize / 2 + relativeAIX * cellSize;
                const aiMapY = aiRoomMapY + cellSize / 2 + relativeAIZ * cellSize;
                
                // AI가 그리드 범위 내에 있는지 확인
                if (aiMapX >= padding && aiMapX < canvas.width - padding && 
                    aiMapY >= padding && aiMapY < canvas.height - padding) {
                    // 파란색 원으로 AI 위치 표시 (플레이어와 구분)
                    ctx.fillStyle = '#0000ff';
                    ctx.beginPath();
                    ctx.arc(aiMapX, aiMapY, showLabels ? 4 : 2, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // AI 이동 방향 표시 (다음 경로 지점으로)
                    if (window.aiState.path && window.aiState.path.length > window.aiState.currentPathIndex) {
                        const nextTarget = window.aiState.path[window.aiState.currentPathIndex];
                        const targetWorldX = nextTarget.x * ROOM_SIZE;
                        const targetWorldZ = nextTarget.y * ROOM_SIZE;
                        const dirX = (targetWorldX - aiMesh.position.x);
                        const dirZ = (targetWorldZ - aiMesh.position.z);
                        const distance = Math.sqrt(dirX * dirX + dirZ * dirZ);
                        
                        if (distance > 0.1) {
                            const angle = Math.atan2(dirX, dirZ);
                            
                            ctx.strokeStyle = '#0000ff';
                            ctx.lineWidth = 2;
                            ctx.beginPath();
                            ctx.moveTo(aiMapX, aiMapY);
                            ctx.lineTo(
                                aiMapX + Math.sin(angle) * (cellSize / 4),
                                aiMapY + Math.cos(angle) * (cellSize / 4)
                            );
                            ctx.stroke();
                        }
                    }
                }
            }
        }
    }
}

// 이동 처리
const moveSpeed = 0.1;
const rotationSpeed = 0.002;

function handleMovement() {
    if (!controls.isLocked || gameState.mapMode) return;
    
    const direction = new THREE.Vector3();
    const cameraDirection = new THREE.Vector3();
    camera.getWorldDirection(cameraDirection);
    
    // 카메라의 오른쪽 벡터 계산 (표준 FPS 이동 방식)
    const cameraRight = new THREE.Vector3();
    cameraRight.crossVectors(cameraDirection, camera.up).normalize();
    
    // code 기반으로 처리 (한국어 입력기와 무관하게 작동)
    if (keys['KeyW']) {
        direction.add(cameraDirection); // 앞으로
    }
    if (keys['KeyS']) {
        direction.sub(cameraDirection); // 뒤로
    }
    if (keys['KeyA']) {
        direction.sub(cameraRight); // 왼쪽 (오른쪽의 반대)
    }
    if (keys['KeyD']) {
        direction.add(cameraRight); // 오른쪽
    }
    
    direction.y = 0;
    direction.normalize();
    direction.multiplyScalar(moveSpeed);
    
    camera.position.add(direction);
    
    // 방 경계 체크
    if (!gameState.currentRoom || !gameState.currentRoom.generated) return;
    
    const roomCenterX = gameState.currentRoom.gridX * ROOM_SIZE;
    const roomCenterZ = gameState.currentRoom.gridY * ROOM_SIZE; // 그리드 y를 z에 매핑
    const halfSize = ROOM_SIZE / 2 - 0.5;
    
    // 열린 문 방향 확인
    let allowPassage = false;
    let passageDirections = [];
    
    // 현재 방의 모든 문 확인
    gameState.currentRoom.doors.forEach((doorDir) => {
        const doorKey = `${gameState.currentRoom.gridX},${gameState.currentRoom.gridY},${doorDir}`;
        const targetGrid = getTargetGrid(gameState.currentRoom.gridX, gameState.currentRoom.gridY, doorDir);
        
        // 그리드 범위 체크 (5x9: x: -2~2, y: -4~4)
        if (targetGrid.x < -2 || targetGrid.x > 2 || targetGrid.y < -4 || targetGrid.y > 4) {
            return; // 그리드 범위를 벗어나면 통과 불가
        }
        
        const targetRoom = gameState.rooms.get(`${targetGrid.x},${targetGrid.y}`);
        
        // 이 문이 열려있거나, 반대편 방의 문이 열려있는지 확인
        if (gameState.openedDoors.has(doorKey)) {
            allowPassage = true;
            passageDirections.push(doorDir);
        } else if (targetRoom && targetRoom.generated) {
            const oppositeDir = (doorDir + 2) % 4;
            const targetDoorKey = `${targetGrid.x},${targetGrid.y},${oppositeDir}`;
            if (gameState.openedDoors.has(targetDoorKey)) {
                allowPassage = true;
                passageDirections.push(doorDir);
            }
        }
    });
    
    // 경계 체크 (열린 문 방향은 여유 있게)
    if (allowPassage && passageDirections.length > 0) {
        const margin = 2.0;
        let xMin = roomCenterX - halfSize;
        let xMax = roomCenterX + halfSize;
        let zMin = roomCenterZ - halfSize;
        let zMax = roomCenterZ + halfSize;
        
        passageDirections.forEach((passageDir) => {
            if (passageDir === 0) { // 북 -> y 감소 = z 감소
                zMin = Math.min(zMin, roomCenterZ - halfSize - margin);
            } else if (passageDir === 1) { // 동
                xMax = Math.max(xMax, roomCenterX + halfSize + margin);
            } else if (passageDir === 2) { // 남 -> y 증가 = z 증가
                zMax = Math.max(zMax, roomCenterZ + halfSize + margin);
            } else if (passageDir === 3) { // 서
                xMin = Math.min(xMin, roomCenterX - halfSize - margin);
            }
        });
        
        const prevX = camera.position.x;
        const prevZ = camera.position.z;
        
        camera.position.x = Math.max(xMin, Math.min(xMax, camera.position.x));
        camera.position.z = Math.max(zMin, Math.min(zMax, camera.position.z));
        
        // 방 경계를 넘었는지 확인하고 방 전환
        const threshold = 0.5; // threshold를 더 크게 조정하여 통과 감지 개선
        passageDirections.forEach((passageDir) => {
            const targetGrid = getTargetGrid(gameState.currentRoom.gridX, gameState.currentRoom.gridY, passageDir);
            const targetKey = `${targetGrid.x},${targetGrid.y}`;
            const targetRoom = gameState.rooms.get(targetKey);
            
            if (!targetRoom || !targetRoom.generated) return;
            
            let passed = false;
            if (passageDir === 0) { // 북 -> y 감소 = z 감소
                // 북쪽 경계를 넘어섰는지 확인 (z가 방의 북쪽 경계보다 작아야 함)
                // margin이 2.0이므로, 플레이어가 경계를 넘어서 이동할 수 있음
                passed = camera.position.z <= roomCenterZ - halfSize + threshold;
            } else if (passageDir === 1) { // 동 -> x가 더 커짐
                passed = camera.position.x >= roomCenterX + halfSize - threshold;
            } else if (passageDir === 2) { // 남 -> y 증가 = z 증가
                passed = camera.position.z >= roomCenterZ + halfSize - threshold;
            } else if (passageDir === 3) { // 서 -> x가 더 작아짐
                passed = camera.position.x <= roomCenterX - halfSize + threshold;
            }
            
            if (passed && (gameState.playerPosition.x !== targetGrid.x || gameState.playerPosition.y !== targetGrid.y)) {
                moveToRoom(targetGrid.x, targetGrid.y);
            }
        });
    } else {
        // 일반 경계 체크
        camera.position.x = Math.max(roomCenterX - halfSize, Math.min(roomCenterX + halfSize, camera.position.x));
        camera.position.z = Math.max(roomCenterZ - halfSize, Math.min(roomCenterZ + halfSize, camera.position.z));
    }
}

// 문 감지 업데이트
function updateDoorDetection() {
    const door = checkNearDoor();
    
    if (door) {
        const doorKey = `${door.userData.gridX},${door.userData.gridY},${door.userData.direction}`;
        const targetGrid = door.userData.targetGrid;
        const targetKey = `${targetGrid.x},${targetGrid.y}`;
        const targetRoom = gameState.rooms.get(targetKey);
        
        // 그리드 범위 체크
        if (targetGrid.x < -2 || targetGrid.x > 2 || targetGrid.y < -4 || targetGrid.y > 4) {
            // 그리드 범위를 벗어나면 문이 없어야 함
            gameState.nearDoor = null;
            return;
        }
        
        // 이미 생성된 방인 경우
        if (targetRoom && targetRoom.generated) {
            // 문이 이미 제거되었으면 통과 가능
            if (gameState.openedDoors.has(doorKey)) {
                // 방 전환 체크는 handleMovement에서 처리
                gameState.nearDoor = null;
            } else {
                // 문을 완전히 제거하고 통로만 남기기 (E키 불필요)
                removeDoorCompletely(door);
                gameState.openedDoors.add(doorKey);
                // 반대편 문도 제거 (문과 문 프레임 모두)
                const entranceAbsoluteDir = (door.userData.direction + 2) % 4;
                const oppositeDoorKey = `${targetGrid.x},${targetGrid.y},${entranceAbsoluteDir}`;
                gameState.openedDoors.add(oppositeDoorKey);
                if (targetRoom.group) {
                    const doorsToRemove = [];
                    const doorFramesToRemove = new Set();
                    
                    targetRoom.group.traverse((child) => {
                        if (child.userData) {
                            // 문 찾기
                            if (child.userData.isDoor && child.userData.direction === entranceAbsoluteDir) {
                                doorsToRemove.push(child);
                                // 문의 doorFrame도 함께 추가
                                if (child.userData.doorFrame) {
                                    doorFramesToRemove.add(child.userData.doorFrame);
                                }
                            }
                            // 문 프레임 찾기 (문과 별도로 찾아야 함)
                            if (child.userData.isDoorFrame && child.userData.doorDirection === entranceAbsoluteDir) {
                                doorFramesToRemove.add(child);
                            }
                        }
                    });
                    
                    // 찾은 문들을 모두 제거 (removeDoorCompletely가 doorFrame도 제거하지만, 혹시 모를 경우를 대비해 별도로도 제거)
                    doorsToRemove.forEach(doorToRemove => {
                        removeDoorCompletely(doorToRemove);
                    });
                    
                    // 문 프레임도 별도로 제거 (중요: removeDoorCompletely가 실패할 수 있으므로 명시적으로 제거)
                    doorFramesToRemove.forEach(frameToRemove => {
                        if (frameToRemove) {
                            // 문 프레임을 직접 제거
                            if (frameToRemove.parent) {
                                frameToRemove.parent.remove(frameToRemove);
                            }
                            // 문 프레임의 material도 정리
                            if (frameToRemove.material) {
                                frameToRemove.material.dispose();
                            }
                            // 문 프레임의 geometry도 정리
                            if (frameToRemove.geometry) {
                                frameToRemove.geometry.dispose();
                            }
                        }
                    });
                }
                gameState.nearDoor = null;
            }
        } else {
            // 아직 생성되지 않은 방 - E키로 선택
            gameState.nearDoor = door;
        }
    } else {
        gameState.nearDoor = null;
    }
    
    const hint = document.getElementById('doorHint');
    if (gameState.nearDoor && !gameState.mapMode) {
        hint.style.display = 'block';
    } else {
        hint.style.display = 'none';
    }
}

// 플레이어 총알 발사
function shootPlayerBullet() {
    if (playerState.ammo <= 0 || !playerState.canShoot) return;
    
    playerState.ammo--;
    playerState.canShoot = false;
    playerState.shootCooldown = 0.2; // 0.2초 쿨다운
    
    // 카메라 방향으로 빔 생성
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    
    // 빔 시작 위치 (카메라 앞)
    const startPos = new THREE.Vector3();
    camera.getWorldPosition(startPos);
    startPos.add(direction.clone().multiplyScalar(0.5));
    
    // 빔 생성 (긴 원기둥 형태)
    const beamGeometry = new THREE.CylinderGeometry(0.05, 0.05, 2, 8);
    const beamMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x00ffff,
        emissive: 0x00ffff,
        emissiveIntensity: 1.0
    });
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    beam.position.copy(startPos);
    
    // 빔을 카메라 방향으로 회전
    beam.lookAt(startPos.clone().add(direction));
    beam.rotateX(Math.PI / 2); // 원기둥이 세로로 서있으므로 회전
    
    scene.add(beam);
    
    // 총알 정보 저장
    const bullet = {
        mesh: beam,
        direction: direction.clone(),
        position: startPos.clone(),
        speed: 0.5,
        damage: 30,
        lifetime: 0,
        maxLifetime: 3.0 // 3초 후 자동 제거
    };
    
    playerBullets.push(bullet);
    updateUI();
}

// 플레이어 총알 업데이트
let lastBulletUpdateTime = performance.now();

function updatePlayerBullets() {
    const currentTime = performance.now();
    const deltaTime = Math.min((currentTime - lastBulletUpdateTime) / 1000, 0.1);
    lastBulletUpdateTime = currentTime;
    
    for (let i = playerBullets.length - 1; i >= 0; i--) {
        const bullet = playerBullets[i];
        bullet.lifetime += deltaTime;
        
        // 수명 초과 시 제거
        if (bullet.lifetime >= bullet.maxLifetime) {
            scene.remove(bullet.mesh);
            bullet.mesh.geometry.dispose();
            bullet.mesh.material.dispose();
            playerBullets.splice(i, 1);
            continue;
        }
        
        // 이동
        const moveVector = bullet.direction.clone().multiplyScalar(bullet.speed);
        bullet.position.add(moveVector);
        bullet.mesh.position.copy(bullet.position);
        
        // AI와 충돌 체크 (AI가 존재하고 사망하지 않았을 때만)
        if (window.aiState && window.aiState.mesh && window.aiState.health > 0) {
            const aiPos = window.aiState.mesh.position;
            const distance = bullet.position.distanceTo(aiPos);
            
            if (distance < 0.5) { // 충돌 감지
                // AI에게 데미지
                if (window.damageAI) {
                    window.damageAI(bullet.damage);
                }
                
                // 총알 제거
                scene.remove(bullet.mesh);
                bullet.mesh.geometry.dispose();
                bullet.mesh.material.dispose();
                playerBullets.splice(i, 1);
            }
        }
    }
    
    // 쿨다운 업데이트
    if (playerState.shootCooldown > 0) {
        playerState.shootCooldown -= deltaTime;
        if (playerState.shootCooldown <= 0) {
            playerState.canShoot = true;
        }
    }
}

// 플레이어 데미지 처리
function damagePlayer(damage) {
    playerState.health -= damage;
    if (playerState.health < 0) {
        playerState.health = 0;
        // 게임 오버 처리 (선택사항)
    }
    updateUI();
}

// UI 업데이트
function updateUI() {
    const ui = document.getElementById('ui');
    if (ui) {
        ui.innerHTML = `
            <div>WASD: 이동 | 마우스: 시야 조절</div>
            <div>E: 새 방 생성 (방 종류 선택)</div>
            <div>E: 맵 보기 (문 근처가 아닐 때)</div>
            <div>ESC: 맵 닫기</div>
            <div style="margin-top: 10px; color: #ff0000;">체력: ${playerState.health}/${playerState.maxHealth}</div>
            <div style="color: #00ffff;">탄약: ${playerState.ammo}/${playerState.maxAmmo}</div>
        `;
    }
}

// 문 통과 체크 (열린 문은 E키 없이 자동으로 통과 가능)
function checkDoorPassage(door) {
    const doorDirection = door.userData.direction;
    const targetGrid = door.userData.targetGrid;
    const currentGrid = gameState.playerPosition;
    
    // 현재 방의 중심
    const roomCenterX = currentGrid.x * ROOM_SIZE;
    const roomCenterZ = currentGrid.y * ROOM_SIZE;
    
    // 문의 월드 위치
    const doorWorldPos = new THREE.Vector3();
    door.getWorldPosition(doorWorldPos);
    
    // 플레이어와 문 사이의 거리
    const playerPos = new THREE.Vector3();
    camera.getWorldPosition(playerPos);
    const distanceToDoor = playerPos.distanceTo(doorWorldPos);
    
    // 문을 통과했는지 확인 (방 경계를 넘었는지)
    let passed = false;
    const threshold = 0.5; // 문 통과 임계값
    
    if (doorDirection === 0) { // 북 -> y 감소 = z 감소
        passed = camera.position.z < roomCenterZ - ROOM_SIZE / 2 + threshold && distanceToDoor < 2.0;
    } else if (doorDirection === 1) { // 동 -> x가 더 커짐
        passed = camera.position.x > roomCenterX + ROOM_SIZE / 2 - threshold && distanceToDoor < 2.0;
    } else if (doorDirection === 2) { // 남 -> y 증가 = z 증가
        passed = camera.position.z > roomCenterZ + ROOM_SIZE / 2 - threshold && distanceToDoor < 2.0;
    } else if (doorDirection === 3) { // 서 -> x가 더 작아짐
        passed = camera.position.x < roomCenterX - ROOM_SIZE / 2 + threshold && distanceToDoor < 2.0;
    }
    
    if (passed) {
        // 새 방으로 이동 (순간이동 없이 자연스럽게)
        moveToRoom(targetGrid.x, targetGrid.y);
    }
}

// 애니메이션 루프
let lastFrameTime = performance.now();

function animate() {
    requestAnimationFrame(animate);
    
    const currentTime = performance.now();
    const deltaTime = Math.min((currentTime - lastFrameTime) / 1000, 0.1); // 최대 0.1초로 제한 (프레임 드롭 방지)
    lastFrameTime = currentTime;
    
    if (!gameState.mapMode) {
        handleMovement();
        updateDoorDetection();
        
        // 미니맵을 매 프레임마다 그리지 않고 일정 시간마다만 업데이트 (성능 최적화)
        const now = Date.now();
        if (!window.lastMinimapUpdate) window.lastMinimapUpdate = 0;
        const MINIMAP_UPDATE_INTERVAL = 100; // 100ms마다 업데이트 (10fps)
        if (now - window.lastMinimapUpdate >= MINIMAP_UPDATE_INTERVAL) {
            drawMinimap();
            window.lastMinimapUpdate = now;
        }
        
        updatePlayerBullets(); // 플레이어 총알 업데이트
    }
    
    // AI 업데이트 (ai.js가 로드되었으면)
    if (typeof window.updateAI === 'function') {
        window.updateAI();
    }
    
    renderer.render(scene, camera);
}

// 초기화
createStartRoom();
drawMinimap(); // 초기 미니맵 그리기
updateUI(); // 초기 UI 업데이트

// AI에서 사용할 함수들과 변수를 전역에 노출
window.getTargetGrid = getTargetGrid;
window.ROOM_SIZE = ROOM_SIZE;
window.gameState = gameState;
window.scene = scene;
window.createRoom = createRoom;
window.relativeToAbsolute = relativeToAbsolute;
window.selectThreeRoomTypes = selectThreeRoomTypes;
window.drawMinimap = drawMinimap;
window.removeDoorCompletely = removeDoorCompletely;
window.camera = camera;
window.damagePlayer = damagePlayer;
window.playerState = playerState;

// AI 초기화 (ai.js가 로드되었으면)
setTimeout(() => {
    console.log('AI 초기화 시도, initAI:', typeof window.initAI);
    if (typeof window.initAI === 'function') {
        window.initAI();
    } else {
        console.error('AI 초기화 함수를 찾을 수 없습니다.');
    }
}, 1000); // 게임 초기화 후 약간의 지연 후 AI 초기화
// 목표 방 미리 생성 (임시로 (3, 0)에)
// 실제로는 플레이어가 도달할 때 생성되도록 할 수도 있음

// 리사이즈 처리
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();


