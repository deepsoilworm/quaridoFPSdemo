import * as THREE from 'three';

// AI 엔티티 관리
// AI는 최북단(y=-4)에서 시작해서 최남단(y=4)으로 가는 것이 목표
// game.js의 전역 변수와 함수를 사용

// ROOM_SIZE는 game.js에서 가져옴
const AI_ROOM_SIZE = window.ROOM_SIZE || 8;

// AI 상태
const aiState = {
    position: { x: 0, y: -4 }, // 최북단에서 시작
    targetPosition: { x: 0, y: 4 }, // 최남단 가운데가 목표
    waypoint: { x: 1, y: 0 }, // 동쪽 중앙 방을 경유
    reachedWaypoint: false, // 경유점 도달 여부
    mesh: null, // 3D 메시
    path: [], // 이동 경로
    currentPathIndex: 0,
    speed: 0.05, // 이동 속도
    reached: false, // 목표 도달 여부
    lastPathCheckTime: 0, // 마지막 경로 체크 시간 (밀리초)
    checkingPath: false, // 경로 체크 중 플래그
    health: 100, // AI 체력
    maxHealth: 100,
    canShoot: true,
    shootCooldown: 0,
    lastShootTime: 0,
    detectionRange: 15, // 플레이어 감지 범위
    lastRoomCreateTime: 0, // 마지막 방 생성 시간 (밀리초)
    roomCreateCooldown: 500 // 방 생성 쿨다운 (0.5초)
};

// AI 총알 배열
const aiBullets = [];


// AI 메시 생성
function createAIMesh() {
    const scene = window.scene;
    if (!scene) {
        console.error('AI: scene을 찾을 수 없습니다.');
        return null;
    }
    
    const aiGeometry = new THREE.SphereGeometry(0.3, 8, 8);
    const aiMaterial = new THREE.MeshStandardMaterial({ 
        color: 0x00ff00, // 초록색 (플레이어와 구분)
        emissive: 0x00ff00,
        emissiveIntensity: 0.8
    });
    const aiMesh = new THREE.Mesh(aiGeometry, aiMaterial);
    aiMesh.position.set(0, 1.0, -32); // 최북단 y=-4 = z=-32, 높이 1.0으로 올림
    aiMesh.castShadow = true;
    aiState.mesh = aiMesh;
    scene.add(aiMesh);
    console.log('AI 메시 생성 완료:', aiMesh.position);
    return aiMesh;
}

// 문 통과 가능 여부 확인 (경로 탐색용 - 방이 없어도 통과 가능하다고 가정, 가상의 경로)
function canPassDoorForPathfinding(gridX, gridY, direction) {
    const getTargetGridFunc = window.getTargetGrid;
    if (!getTargetGridFunc) return false;
    const targetGrid = getTargetGridFunc(gridX, gridY, direction);
    
    // 그리드 범위 체크
    if (targetGrid.x < -2 || targetGrid.x > 2 || targetGrid.y < -4 || targetGrid.y > 4) {
        return false;
    }
    
    // 경로 탐색용이므로 방이 없어도 통과 가능 (가상의 경로)
    // 현재 방이 생성되어 있으면 문이 있는지 확인하지만, 없어도 가상으로 통과 가능
    const gameState = window.gameState;
    if (gameState) {
        const currentRoom = gameState.rooms.get(`${gridX},${gridY}`);
        // 현재 방이 생성되어 있고 문이 없으면 통과 불가
        if (currentRoom && currentRoom.generated) {
            if (!currentRoom.doors.includes(direction)) {
                return false; // 현재 방에 문이 없으면 통과 불가
            }
        }
    }
    
    // 목표 방이 없어도 통과 가능 (가상의 경로, AI가 생성할 수 있음)
    return true;
}

// 문 통과 가능 여부 확인 (실제 이동용 - 양쪽 방 모두에 문이 있어야 함)
function canPassDoorForMovement(gridX, gridY, direction) {
    const getTargetGridFunc = window.getTargetGrid;
    if (!getTargetGridFunc) return false;
    const targetGrid = getTargetGridFunc(gridX, gridY, direction);
    
    // 그리드 범위 체크
    if (targetGrid.x < -2 || targetGrid.x > 2 || targetGrid.y < -4 || targetGrid.y > 4) {
        return false;
    }
    
    const gameState = window.gameState;
    if (!gameState) return false;
    
    const currentRoom = gameState.rooms.get(`${gridX},${gridY}`);
    const targetRoom = gameState.rooms.get(`${targetGrid.x},${targetGrid.y}`);
    
    // 현재 방이 생성되어 있어야 함
    if (!currentRoom || !currentRoom.generated) {
        return false;
    }
    
    // 현재 방에 해당 방향 문이 있어야 함
    if (!currentRoom.doors.includes(direction)) {
        return false;
    }
    
    // 목표 방이 생성되지 않았으면 통과 불가 (생성 필요)
    if (!targetRoom || !targetRoom.generated) {
        return false;
    }
    
    // 목표 방이 생성되어 있으면 반대 방향 문이 있어야 함 (양방향)
    const oppositeDir = (direction + 2) % 4;
    if (!targetRoom.doors.includes(oppositeDir)) {
        return false;
    }
    
    return true;
}

// AI가 방 생성
function aiCreateRoom(gridX, gridY, fromDirection) {
    const gameState = window.gameState;
    const scene = window.scene;
    const getTargetGridFunc = window.getTargetGrid;
    const createRoomFunc = window.createRoom;
    const relativeToAbsoluteFunc = window.relativeToAbsolute;
    const selectThreeRoomTypesFunc = window.selectThreeRoomTypes;
    
    if (!gameState || !scene || !getTargetGridFunc || !createRoomFunc || !relativeToAbsoluteFunc || !selectThreeRoomTypesFunc) {
        return false;
    }
    
    const targetKey = `${gridX},${gridY}`;
    const existingRoom = gameState.rooms.get(targetKey);
    
    // 이미 생성되어 있으면 반대편 문만 확인/추가
    if (existingRoom && existingRoom.generated) {
        const entranceAbsoluteDir = (fromDirection + 2) % 4;
        if (!existingRoom.doors.includes(entranceAbsoluteDir)) {
            // 문 추가는 복잡하므로 일단 생성된 방은 그대로 사용
            return false;
        }
        return true;
    }
    
    // 입구 절대 방향 (들어온 문의 반대 방향)
    const entranceAbsoluteDir = (fromDirection + 2) % 4;
    
    // AI는 목표 방향(남쪽)으로 가는 경로를 선호하므로, 남쪽으로 가는 방 타입 우선 선택
    const roomOptions = selectThreeRoomTypesFunc(entranceAbsoluteDir);
    
    // 남쪽으로 가는 방 우선 선택 (y 증가 = 남쪽)
    let selectedRoom = roomOptions[0];
    for (const option of roomOptions) {
        const absoluteDoors = option.doors.map(relDir => relativeToAbsoluteFunc(relDir, entranceAbsoluteDir));
        if (absoluteDoors.includes(2)) { // 남쪽 문이 있는 방
            selectedRoom = option;
            break;
        }
    }
    
    // 상대적 방향을 절대적 방향으로 변환
    let absoluteDoors = selectedRoom.doors.map(relDir => relativeToAbsoluteFunc(relDir, entranceAbsoluteDir));
    
    // 입구는 항상 있어야 함
    if (!absoluteDoors.includes(entranceAbsoluteDir)) {
        absoluteDoors.push(entranceAbsoluteDir);
    }
    
    // 그리드 범위를 벗어나는 방향의 문 필터링
    absoluteDoors = absoluteDoors.filter((doorDir) => {
        const testTargetGrid = getTargetGridFunc(gridX, gridY, doorDir);
        return testTargetGrid.x >= -2 && testTargetGrid.x <= 2 && 
               testTargetGrid.y >= -4 && testTargetGrid.y <= 4;
    });
    
    // 입구가 필터링되어 제거되었으면 다시 추가
    if (!absoluteDoors.includes(entranceAbsoluteDir)) {
        absoluteDoors.push(entranceAbsoluteDir);
    }
    
    // 기존 빈 방 제거
    if (existingRoom && existingRoom.group) {
        scene.remove(existingRoom.group);
    }
    
    // 새 방 생성
    const newRoom = createRoomFunc(gridX, gridY, selectedRoom.type, absoluteDoors);
    
    if (!newRoom || !newRoom.group) {
        return false;
    }
    
    gameState.rooms.set(targetKey, newRoom);
    scene.add(newRoom.group);
    
    // 현재 방 위치 계산 (fromDirection의 반대)
    const fromGrid = getTargetGridFunc ? getTargetGridFunc(gridX, gridY, (fromDirection + 2) % 4) : null;
    const fromRoom = fromGrid ? gameState.rooms.get(`${fromGrid.x},${fromGrid.y}`) : null;
    
    // 현재 방에서 문 제거 (플레이어가 있는 방이 아닌 경우에만, 안전하게 처리)
    const removeDoorCompletelyFunc = window.removeDoorCompletely;
    if (fromGrid && fromRoom && fromRoom.generated && fromRoom.group && removeDoorCompletelyFunc) {
        try {
            const currentPlayerRoom = gameState.currentRoom;
            const isPlayerInFromRoom = currentPlayerRoom && 
                                        currentPlayerRoom.gridX === fromGrid.x && 
                                        currentPlayerRoom.gridY === fromGrid.y;
            
            // 플레이어가 있는 방이 아니면 문 제거
            if (!isPlayerInFromRoom && fromRoom.group && typeof fromRoom.group.traverse === 'function') {
                fromRoom.group.traverse((child) => {
                    if (child.userData && child.userData.isDoor && 
                        child.userData.direction === fromDirection &&
                        child.userData.gridX === fromGrid.x &&
                        child.userData.gridY === fromGrid.y) {
                        try {
                            removeDoorCompletelyFunc(child);
                        } catch (error) {
                            console.error('AI 문 제거 오류:', error);
                        }
                    }
                });
                
                // openedDoors에 추가
                const doorKey = `${fromGrid.x},${fromGrid.y},${fromDirection}`;
                gameState.openedDoors.add(doorKey);
            }
        } catch (error) {
            console.error('AI 방 생성 중 문 제거 오류:', error);
        }
    }
    
    // 새로 생성한 방의 입구 문도 제거
    const entranceAbsoluteDir2 = (fromDirection + 2) % 4;
    if (removeDoorCompletelyFunc && newRoom.group) {
        try {
            const doorsToRemove = [];
            const doorFramesToRemove = new Set();
            
            newRoom.group.traverse((child) => {
                if (child.userData) {
                    if (child.userData.isDoor && child.userData.direction === entranceAbsoluteDir2) {
                        doorsToRemove.push(child);
                        if (child.userData.doorFrame) {
                            doorFramesToRemove.add(child.userData.doorFrame);
                        }
                    }
                    if (child.userData.isDoorFrame && child.userData.doorDirection === entranceAbsoluteDir2) {
                        doorFramesToRemove.add(child);
                    }
                }
            });
            
            doorsToRemove.forEach(doorToRemove => {
                try {
                    removeDoorCompletelyFunc(doorToRemove);
                } catch (error) {
                    console.error('AI 방 생성 중 문 제거 오류:', error);
                }
            });
            
            doorFramesToRemove.forEach(frameToRemove => {
                try {
                    if (frameToRemove && frameToRemove.parent) {
                        frameToRemove.parent.remove(frameToRemove);
                    }
                } catch (error) {
                    console.error('AI 방 생성 중 문 프레임 제거 오류:', error);
                }
            });
            
            // openedDoors에 추가
            const doorKey2 = `${gridX},${gridY},${entranceAbsoluteDir2}`;
            gameState.openedDoors.add(doorKey2);
        } catch (error) {
            console.error('AI 방 생성 중 문 제거 오류:', error);
        }
    }
    
    // 미니맵은 animate 루프에서 자동으로 업데이트되므로 여기서 호출하지 않음
    // (렌더링 블로킹 방지)
    
    console.log(`AI가 방 생성: (${gridX}, ${gridY})`);
    return true;
}

// BFS를 사용한 경로 탐색 (방 생성을 하지 않고 경로만 찾기)
function findPath(startX, startY, targetX, targetY) {
    const queue = [[{ x: startX, y: startY }]];
    const visited = new Set();
    visited.add(`${startX},${startY}`);
    
    while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];
        
        // 목표에 도달
        if (current.x === targetX && current.y === targetY) {
            return path;
        }
        
        // 4방향 탐색 (북, 동, 남, 서)
        const directions = [
            { x: 0, y: -1 }, // 북
            { x: 1, y: 0 },  // 동
            { x: 0, y: 1 },  // 남
            { x: -1, y: 0 }  // 서
        ];
        
        for (let i = 0; i < 4; i++) {
            const dir = directions[i];
            const nextX = current.x + dir.x;
            const nextY = current.y + dir.y;
            const nextKey = `${nextX},${nextY}`;
            
            // 이미 방문했거나 그리드 범위 밖
            if (visited.has(nextKey)) continue;
            if (nextX < -2 || nextX > 2 || nextY < -4 || nextY > 4) continue;
            
            // 문을 통과할 수 있는지 확인 (경로 탐색용 - 방이 없어도 통과 가능)
            if (canPassDoorForPathfinding(current.x, current.y, i)) {
                visited.add(nextKey);
                const newPath = [...path, { x: nextX, y: nextY }];
                queue.push(newPath);
            }
        }
    }
    
    return null; // 경로를 찾을 수 없음
}

// AI 경로 업데이트 (20초마다 또는 경로가 없을 때만)
function updateAIPath() {
    if (aiState.reached || aiState.checkingPath) return;
    
    // 목표에 이미 도달했는지 확인
    if (aiState.position.x === aiState.targetPosition.x && 
        aiState.position.y === aiState.targetPosition.y) {
        aiState.reached = true;
        console.log('AI가 목표에 도달했습니다!');
        return;
    }
    
    const now = Date.now();
    const timeSinceLastCheck = now - aiState.lastPathCheckTime;
    const shouldCheck = aiState.path.length === 0 || 
                        aiState.currentPathIndex >= aiState.path.length ||
                        timeSinceLastCheck >= 20000; // 20초마다
    
    if (shouldCheck) {
        aiState.checkingPath = true;
        aiState.lastPathCheckTime = now;
        
        // 경유점을 거쳐서 가는 경로 계산
        let newPath = [];
        
        // 현재 위치가 경유점에 도달했는지 확인
        if (!aiState.reachedWaypoint) {
            // 1단계: 현재 위치 → 경유점 (동쪽 중앙 방)
            const pathToWaypoint = findPath(
                aiState.position.x, 
                aiState.position.y,
                aiState.waypoint.x,
                aiState.waypoint.y
            );
            
            if (pathToWaypoint && pathToWaypoint.length > 0) {
                // 2단계: 경유점 → 목표점
                const pathFromWaypoint = findPath(
                    aiState.waypoint.x,
                    aiState.waypoint.y,
                    aiState.targetPosition.x,
                    aiState.targetPosition.y
                );
                
                if (pathFromWaypoint && pathFromWaypoint.length > 0) {
                    // 두 경로를 합치기 (경유점은 중복 제거)
                    newPath = [...pathToWaypoint, ...pathFromWaypoint.slice(1)];
                } else {
                    // 경유점에서 목표로 가는 경로를 못 찾으면 경유점까지만
                    newPath = pathToWaypoint;
                }
            }
        } else {
            // 경유점에 도달했으면 경유점 → 목표점 경로만
            const pathFromWaypoint = findPath(
                aiState.waypoint.x,
                aiState.waypoint.y,
                aiState.targetPosition.x,
                aiState.targetPosition.y
            );
            
            if (pathFromWaypoint && pathFromWaypoint.length > 0) {
                newPath = pathFromWaypoint;
            }
        }
        
        if (newPath && newPath.length > 0) {
            aiState.path = newPath;
            aiState.currentPathIndex = 1; // 시작점 제외
            console.log('AI 경로 탐색 완료 (경유점 포함):', newPath);
        } else {
            // 경로를 찾을 수 없으면 목표 방향으로 새 방 생성하여 이동
            console.log('AI 경로를 찾을 수 없습니다. 목표 방향으로 새 방 생성 시도...');
            
            // 목표 방향 계산
            const targetX = !aiState.reachedWaypoint ? aiState.waypoint.x : aiState.targetPosition.x;
            const targetY = !aiState.reachedWaypoint ? aiState.waypoint.y : aiState.targetPosition.y;
            
            // 현재 위치에서 목표로 가는 가장 가까운 방향 찾기
            const dx = targetX - aiState.position.x;
            const dy = targetY - aiState.position.y;
            
            // 우선순위: 남쪽(y 증가) > 동쪽(x 증가) > 북쪽(y 감소) > 서쪽(x 감소)
            let nextX = aiState.position.x;
            let nextY = aiState.position.y;
            let direction = -1;
            
            if (dy > 0) {
                nextY += 1; // 남쪽
                direction = 2;
            } else if (dy < 0) {
                nextY -= 1; // 북쪽
                direction = 0;
            } else if (dx > 0) {
                nextX += 1; // 동쪽
                direction = 1;
            } else if (dx < 0) {
                nextX -= 1; // 서쪽
                direction = 3;
            }
            
            // 그리드 범위 체크
            if (nextX >= -2 && nextX <= 2 && nextY >= -4 && nextY <= 4 && direction !== -1) {
                // 다음 위치로 가는 방 생성 시도
                const created = aiCreateRoom(nextX, nextY, direction);
                if (created) {
                    // 방 생성 성공 시 경로에 추가
                    aiState.path = [
                        { x: aiState.position.x, y: aiState.position.y },
                        { x: nextX, y: nextY }
                    ];
                    aiState.currentPathIndex = 1;
                    console.log('AI 새 방 생성 성공, 경로에 추가:', aiState.path);
                } else {
                    // 방 생성 실패 시 다른 방향 시도
                    console.log('AI 방 생성 실패, 다른 방향 시도...');
                    // 4방향 모두 시도
                    const directions = [
                        { dir: 2, x: aiState.position.x, y: aiState.position.y + 1 }, // 남
                        { dir: 1, x: aiState.position.x + 1, y: aiState.position.y }, // 동
                        { dir: 0, x: aiState.position.x, y: aiState.position.y - 1 }, // 북
                        { dir: 3, x: aiState.position.x - 1, y: aiState.position.y } // 서
                    ];
                    
                    let found = false;
                    const now = Date.now();
                    // 방 생성 쿨다운 체크
                    if (now - aiState.lastRoomCreateTime >= aiState.roomCreateCooldown) {
                        for (const d of directions) {
                            if (d.x >= -2 && d.x <= 2 && d.y >= -4 && d.y <= 4) {
                                const created = aiCreateRoom(d.x, d.y, d.dir);
                                if (created) {
                                    aiState.path = [
                                        { x: aiState.position.x, y: aiState.position.y },
                                        { x: d.x, y: d.y }
                                    ];
                                    aiState.currentPathIndex = 1;
                                    console.log('AI 다른 방향으로 새 방 생성 성공:', aiState.path);
                                    found = true;
                                    aiState.lastRoomCreateTime = now;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (!found) {
                        console.log('AI 모든 방향으로 방 생성 실패 또는 쿨다운 중');
                    }
                }
            }
        }
        
        aiState.checkingPath = false;
    }
}

// AI 이동 업데이트
let lastMovementUpdate = 0;

function updateAIMovement() {
    if (!aiState.mesh || aiState.reached) return;
    
    const now = Date.now();
    
    // 경로가 없으면 경로 재탐색 시도 (1초마다만)
    if (aiState.path.length === 0) {
        if (now - lastMovementUpdate >= 1000) {
            updateAIPath();
            lastMovementUpdate = now;
        }
        return;
    }
    
    // 현재 방이 생성되어 있는지 확인 (없으면 생성 불가능하므로 경로 재탐색)
    const currentKey = `${aiState.position.x},${aiState.position.y}`;
    const currentRoom = window.gameState?.rooms.get(currentKey);
    if (!currentRoom || !currentRoom.generated) {
        // 현재 방이 없으면 경로 재탐색 (1초마다만)
        if (now - lastMovementUpdate >= 1000) {
            console.log('AI 현재 방이 없음, 경로 재탐색');
            aiState.path = [];
            aiState.currentPathIndex = 0;
            updateAIPath();
            lastMovementUpdate = now;
        }
        return;
    }
    
    if (aiState.currentPathIndex >= aiState.path.length) {
        // 경로의 끝에 도달했지만 목표가 아닐 수 있음 (1초마다만)
        if (now - lastMovementUpdate >= 1000) {
            updateAIPath();
            lastMovementUpdate = now;
        }
        return;
    }
    
    const currentTarget = aiState.path[aiState.currentPathIndex];
    
    // 이동하기 전에 다음 방이 실제로 생성되어 있고 통과 가능한지 확인
    const targetKey = `${currentTarget.x},${currentTarget.y}`;
    const targetRoom = window.gameState?.rooms.get(targetKey);
    
    // 현재 위치에서 목표 위치로 가는 방향 찾기
    const dx = currentTarget.x - aiState.position.x;
    const dy = currentTarget.y - aiState.position.y;
    let direction = -1;
    
    if (dx === 1) direction = 1; // 동
    else if (dx === -1) direction = 3; // 서
    else if (dy === 1) direction = 2; // 남
    else if (dy === -1) direction = 0; // 북
    
    // 목표 방이 없거나 생성되지 않았으면 먼저 생성 (쿨다운 체크)
    if (!targetRoom || !targetRoom.generated) {
        if (direction !== -1 && now - aiState.lastRoomCreateTime >= aiState.roomCreateCooldown) {
            console.log(`AI 이동 전 다음 방 생성: (${currentTarget.x}, ${currentTarget.y})`);
            const created = aiCreateRoom(currentTarget.x, currentTarget.y, direction);
            aiState.lastRoomCreateTime = now;
            
            if (!created) {
                // 방 생성 실패 시 다른 방향으로 새 방 생성 시도 (한 번만)
                console.log('AI 방 생성 실패, 다른 방향으로 새 방 생성 시도...');
                
                // 4방향 모두 시도 (목표 방향 제외)
                const directions = [
                    { dir: 2, x: aiState.position.x, y: aiState.position.y + 1 }, // 남
                    { dir: 1, x: aiState.position.x + 1, y: aiState.position.y }, // 동
                    { dir: 0, x: aiState.position.x, y: aiState.position.y - 1 }, // 북
                    { dir: 3, x: aiState.position.x - 1, y: aiState.position.y } // 서
                ];
                
                let found = false;
                for (const d of directions) {
                    if (d.x >= -2 && d.x <= 2 && d.y >= -4 && d.y <= 4) {
                        // 이미 시도한 방향은 건너뛰기
                        if (d.dir === direction && d.x === currentTarget.x && d.y === currentTarget.y) {
                            continue;
                        }
                        
                        const created = aiCreateRoom(d.x, d.y, d.dir);
                        if (created) {
                            // 경로 업데이트
                            aiState.path[aiState.currentPathIndex] = { x: d.x, y: d.y };
                            console.log('AI 다른 방향으로 새 방 생성 성공:', d);
                            found = true;
                            break;
                        }
                    }
                }
                
                if (!found) {
                    // 모든 방향 실패 시 경로 재탐색 (1초 후)
                    console.log('AI 모든 방향으로 방 생성 실패, 경로 재탐색 예약');
                    aiState.path = [];
                    aiState.currentPathIndex = 0;
                    lastMovementUpdate = now; // 재탐색 쿨다운 설정
                }
            }
        }
        return; // 방 생성 후 다음 프레임에 이동
    }
    
    // 목표 방이 있으면 통과 가능한지 확인
    if (direction !== -1 && !canPassDoorForMovement(aiState.position.x, aiState.position.y, direction)) {
        // 통과할 수 없으면 다른 방향으로 새 방 생성 시도 (쿨다운 체크)
        if (now - aiState.lastRoomCreateTime >= aiState.roomCreateCooldown) {
            console.log('AI 통과 불가, 다른 방향으로 새 방 생성 시도...');
            
            // 4방향 모두 시도
            const directions = [
                { dir: 2, x: aiState.position.x, y: aiState.position.y + 1 }, // 남
                { dir: 1, x: aiState.position.x + 1, y: aiState.position.y }, // 동
                { dir: 0, x: aiState.position.x, y: aiState.position.y - 1 }, // 북
                { dir: 3, x: aiState.position.x - 1, y: aiState.position.y } // 서
            ];
            
            let found = false;
            for (const d of directions) {
                if (d.x >= -2 && d.x <= 2 && d.y >= -4 && d.y <= 4) {
                    // 이미 시도한 방향은 건너뛰기
                    if (d.dir === direction) {
                        continue;
                    }
                    
                    const created = aiCreateRoom(d.x, d.y, d.dir);
                    if (created) {
                        // 경로 업데이트
                        aiState.path[aiState.currentPathIndex] = { x: d.x, y: d.y };
                        console.log('AI 다른 방향으로 새 방 생성 성공:', d);
                        found = true;
                        aiState.lastRoomCreateTime = now;
                        break;
                    }
                }
            }
            
            if (!found) {
                // 모든 방향 실패 시 경로 재탐색 (1초 후)
                console.log('AI 모든 방향으로 방 생성 실패, 경로 재탐색 예약');
                aiState.path = [];
                aiState.currentPathIndex = 0;
                lastMovementUpdate = now; // 재탐색 쿨다운 설정
            }
        }
        return;
    }
    
    // 목표 방이 생성되어 있고 통과 가능하므로 이동 시작
    const currentWorldX = aiState.position.x * AI_ROOM_SIZE;
    const currentWorldZ = aiState.position.y * AI_ROOM_SIZE;
    const targetWorldX = currentTarget.x * AI_ROOM_SIZE;
    const targetWorldZ = currentTarget.y * AI_ROOM_SIZE;
    
    // 현재 위치와 목표 위치 사이의 거리
    const distX = targetWorldX - aiState.mesh.position.x;
    const distZ = targetWorldZ - aiState.mesh.position.z;
    const distance = Math.sqrt(distX * distX + distZ * distZ);
    
    if (distance < 0.1) {
        // 목표 위치에 도달
        aiState.position = { x: currentTarget.x, y: currentTarget.y };
        aiState.currentPathIndex++;
        
        // 경유점에 도달했는지 확인
        if (!aiState.reachedWaypoint && 
            aiState.position.x === aiState.waypoint.x && 
            aiState.position.y === aiState.waypoint.y) {
            aiState.reachedWaypoint = true;
            console.log('AI가 경유점(동쪽 중앙 방)에 도달했습니다!');
            // 경로 재탐색
            aiState.path = [];
            aiState.currentPathIndex = 0;
            updateAIPath();
            return;
        }
        
        // 목표에 도달했는지 확인
        if (aiState.position.x === aiState.targetPosition.x && 
            aiState.position.y === aiState.targetPosition.y) {
            aiState.reached = true;
            console.log('AI가 목표에 도달했습니다!');
            return;
        }
        
        // 다음 경로를 위해 업데이트
        if (aiState.currentPathIndex >= aiState.path.length) {
            updateAIPath();
        }
    } else {
        // 목표 방향으로 이동
        const moveX = (distX / distance) * aiState.speed;
        const moveZ = (distZ / distance) * aiState.speed;
        aiState.mesh.position.x += moveX;
        aiState.mesh.position.z += moveZ;
    }
}

// AI 초기화
function initAI() {
    console.log('AI 초기화 시작');
    
    const gameState = window.gameState;
    if (!gameState) {
        console.error('AI: gameState를 찾을 수 없습니다.');
        return;
    }
    
    // AI 시작 위치(최북단)에 방이 없으면 생성
    const aiStartKey = '0,-4';
    const aiStartRoom = gameState.rooms.get(aiStartKey);
    if (!aiStartRoom || !aiStartRoom.generated) {
        console.log('AI 시작 방 생성 중...');
        // 최북단 방 생성 (남쪽으로 나가는 문이 있어야 함)
        // y=-4에서 남쪽(direction 2)으로 가면 y=-3
        const aiStartDoors = [2, 1, 3]; // 남쪽, 동쪽, 서쪽 (북쪽은 범위 밖)
        if (window.createRoom) {
            const room = window.createRoom(0, -4, 'ai_start', aiStartDoors);
            gameState.rooms.set(aiStartKey, room);
            window.scene.add(room.group);
            console.log('AI 시작 방 생성 완료');
        }
    }
    
    const mesh = createAIMesh();
    if (!mesh) {
        console.error('AI 메시 생성 실패');
        return;
    }
    
    aiState.position = { x: 0, y: -4 };
    aiState.currentPathIndex = 0;
    aiState.path = [];
    aiState.reached = false;
    aiState.lastPathCheckTime = Date.now();
    aiState.checkingPath = false;
    
    // AI 상태를 window에 노출 (미니맵 표시를 위해)
    window.aiState = aiState;
    
    console.log('AI 초기화 완료, 위치:', aiState.position);
    
    // 경로 탐색 시작
    setTimeout(() => {
        updateAIPath();
    }, 1000); // 1초 후 경로 탐색 시작
}

// window에 노출
window.initAI = initAI;
window.updateAI = updateAI;
window.damageAI = damageAI;

// AI 총알 발사
function shootAIBullet() {
    if (!aiState.canShoot || !aiState.mesh) return;
    
    const camera = window.camera;
    if (!camera) return;
    
    // 플레이어 위치
    const playerPos = new THREE.Vector3();
    camera.getWorldPosition(playerPos);
    
    // AI 위치
    const aiPos = aiState.mesh.position;
    
    // 방향 계산
    const direction = new THREE.Vector3();
    direction.subVectors(playerPos, aiPos).normalize();
    
    // 총알 시작 위치 (AI 앞)
    const startPos = aiPos.clone();
    startPos.add(direction.clone().multiplyScalar(0.5));
    startPos.y = 1.0; // 플레이어 눈 높이
    
    // 총알 생성 (느린 총알)
    const bulletGeometry = new THREE.SphereGeometry(0.1, 8, 8);
    const bulletMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xff0000,
        emissive: 0xff0000,
        emissiveIntensity: 0.8
    });
    const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
    bullet.position.copy(startPos);
    
    const scene = window.scene;
    if (scene) {
        scene.add(bullet);
    }
    
    // 총알 정보 저장
    const bulletData = {
        mesh: bullet,
        direction: direction.clone(),
        position: startPos.clone(),
        speed: 0.15, // 느린 속도
        damage: 30,
        lifetime: 0,
        maxLifetime: 5.0 // 5초 후 자동 제거
    };
    
    aiBullets.push(bulletData);
    
    aiState.canShoot = false;
    aiState.shootCooldown = 2.0; // 2초 쿨다운
    aiState.lastShootTime = Date.now();
}

// AI 총알 업데이트
let lastAIBulletUpdateTime = performance.now();

function updateAIBullets() {
    const camera = window.camera;
    if (!camera) return;
    
    const currentTime = performance.now();
    const deltaTime = Math.min((currentTime - lastAIBulletUpdateTime) / 1000, 0.1);
    lastAIBulletUpdateTime = currentTime;
    
    for (let i = aiBullets.length - 1; i >= 0; i--) {
        const bullet = aiBullets[i];
        bullet.lifetime += deltaTime;
        
        // 수명 초과 시 제거
        if (bullet.lifetime >= bullet.maxLifetime) {
            const scene = window.scene;
            if (scene) {
                scene.remove(bullet.mesh);
            }
            bullet.mesh.geometry.dispose();
            bullet.mesh.material.dispose();
            aiBullets.splice(i, 1);
            continue;
        }
        
        // 이동
        const moveVector = bullet.direction.clone().multiplyScalar(bullet.speed);
        bullet.position.add(moveVector);
        bullet.mesh.position.copy(bullet.position);
        
        // 플레이어와 충돌 체크
        if (camera) {
            const playerPos = new THREE.Vector3();
            camera.getWorldPosition(playerPos);
            const distance = bullet.position.distanceTo(playerPos);
            
            if (distance < 0.3) { // 충돌 감지
                // 플레이어에게 데미지
                if (window.damagePlayer) {
                    window.damagePlayer(bullet.damage);
                }
                
                // 총알 제거
                const scene = window.scene;
                if (scene) {
                    scene.remove(bullet.mesh);
                }
                bullet.mesh.geometry.dispose();
                bullet.mesh.material.dispose();
                aiBullets.splice(i, 1);
            }
        }
    }
    
    // 쿨다운 업데이트
    if (aiState.shootCooldown > 0) {
        aiState.shootCooldown -= deltaTime;
        if (aiState.shootCooldown <= 0) {
            aiState.canShoot = true;
        }
    }
}

// AI 플레이어 감지 및 공격
function checkPlayerAndShoot() {
    if (!aiState.mesh || aiState.reached || !aiState.canShoot) return;
    
    const camera = window.camera;
    if (!camera) return;
    
    // 플레이어 위치
    const playerPos = new THREE.Vector3();
    camera.getWorldPosition(playerPos);
    
    // AI 위치
    const aiPos = aiState.mesh.position;
    
    // 거리 계산
    const distance = playerPos.distanceTo(aiPos);
    
    // 감지 범위 내에 있으면 발사
    if (distance <= aiState.detectionRange) {
        shootAIBullet();
    }
}

// AI 데미지 처리
function damageAI(damage) {
    aiState.health -= damage;
    if (aiState.health < 0) {
        aiState.health = 0;
        // AI 사망 처리
        if (aiState.mesh) {
            const scene = window.scene;
            if (scene) {
                scene.remove(aiState.mesh);
            }
            aiState.mesh.geometry.dispose();
            aiState.mesh.material.dispose();
            aiState.mesh = null;
        }
        console.log('AI가 사망했습니다!');
    }
}

// AI 업데이트 (애니메이션 루프에서 호출)
let lastAIPathUpdate = 0;
let lastAIShootCheck = 0;

function updateAI() {
    if (!aiState.mesh) return;
    
    const now = Date.now();
    
    // 경로 업데이트는 1초마다만 체크 (updateAIPath 내부에서도 시간 체크하지만, 여기서도 제한)
    if (now - lastAIPathUpdate >= 1000) {
        updateAIPath();
        lastAIPathUpdate = now;
    }
    
    updateAIMovement();
    
    // AI 총알 업데이트
    updateAIBullets();
    
    // 플레이어 감지 및 공격은 0.1초마다만 체크 (너무 자주 호출하지 않음)
    if (now - lastAIShootCheck >= 100) {
        checkPlayerAndShoot();
        lastAIShootCheck = now;
    }
}

