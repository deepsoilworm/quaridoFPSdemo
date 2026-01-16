import * as THREE from 'three';

// AI 엔티티 관리
// AI는 최북단(y=-4)에서 시작해서 최남단(y=4)으로 가는 것이 목표
// game.js의 전역 변수와 함수를 사용

// ROOM_SIZE는 game.js에서 가져옴
const AI_ROOM_SIZE = window.ROOM_SIZE || 8;

// AI 상태
const aiState = {
    position: { x: 0, y: -4 }, // 최북단에서 시작
    targetPosition: { x: 0, y: 4 }, // 최남단 가운데가 목표 (initAI에서 체크포인트로 업데이트됨)
    mesh: null, // 3D 메시
    path: [], // 이동 경로
    currentPathIndex: 0,
    speed: 0.05, // 이동 속도
    reached: false, // 목표 도달 여부
    lastPathCheckTime: 0, // 마지막 경로 체크 시간 (밀리초)
    checkingPath: false, // 경로 체크 중 플래그
    health: 100, // AI 체력
    maxHealth: 100,
    lastRoomCreateTime: 0, // 마지막 방 생성 시간 (밀리초)
    roomCreateCooldown: 500, // 방 생성 쿨다운 (0.5초)
    stuckFrames: 0, // 연속으로 낑긴 프레임 수
    lastStuckCheck: 0 // 마지막 낑김 체크 시간
};



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

// 문 통과 가능 여부 확인 (경로 탐색용 - 플레이어가 만든 방도 인식)
function canPassDoorForPathfinding(gridX, gridY, direction) {
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
    
    // 현재 방이 생성되어 있으면 문이 있는지 확인
    if (currentRoom && currentRoom.generated) {
        if (!currentRoom.doors.includes(direction)) {
            return false; // 현재 방에 문이 없으면 통과 불가
        }
    }
    
    // 목표 방이 이미 생성되어 있으면 (플레이어가 만든 방) 반대편 문도 확인
    if (targetRoom && targetRoom.generated) {
        const oppositeDir = (direction + 2) % 4;
        // 목표 방에 반대 방향 문이 있어야 통과 가능
        if (!targetRoom.doors.includes(oppositeDir)) {
            return false; // 목표 방에 반대편 문이 없으면 통과 불가
        }
        // 양쪽 방 모두 문이 있으면 통과 가능
        return true;
    }
    
    // 목표 방이 없으면 통과 가능 (가상의 경로, AI가 생성할 수 있음)
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
    
    // 반대편 방의 문 상태를 확인하여 일치시키기 (메타 체크)
    const directionNames = ['북', '동', '남', '서'];
    for (let dir = 0; dir < 4; dir++) {
        const oppositeGrid = getTargetGridFunc(gridX, gridY, dir);
        const oppositeKey = `${oppositeGrid.x},${oppositeGrid.y}`;
        const oppositeRoom = gameState.rooms.get(oppositeKey);
        
        // 반대편 방이 존재하고 생성되어 있으면
        if (oppositeRoom && oppositeRoom.generated) {
            const oppositeDir = (dir + 2) % 4; // 반대 방향
            
            // 반대편 방에 해당 방향에 문이 있으면, 새 방에도 그 방향에 문이 있어야 함
            if (oppositeRoom.doors.includes(oppositeDir)) {
                if (!absoluteDoors.includes(dir)) {
                    absoluteDoors.push(dir);
                    console.log(`AI 메타 체크: 반대편 방에 문이 있어서 새 방에도 ${directionNames[dir]} 방향 문 추가`);
                }
            } else {
                // 반대편 방에 문이 없으면, 새 방에도 그 방향에 문이 없어야 함
                const index = absoluteDoors.indexOf(dir);
                if (index !== -1 && dir !== entranceAbsoluteDir) {
                    // 입구는 제외하고 제거
                    absoluteDoors.splice(index, 1);
                    console.log(`AI 메타 체크: 반대편 방에 문이 없어서 새 방의 ${directionNames[dir]} 방향 문 제거`);
                }
            }
        }
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
    
    // 현재 방에서 문 제거 (플레이어가 있는 방이어도 문을 제거)
    const removeDoorCompletelyFunc = window.removeDoorCompletely;
    if (fromGrid && fromRoom && fromRoom.generated && fromRoom.group && removeDoorCompletelyFunc) {
        try {
            // 플레이어가 있는 방이어도 문을 제거 (시각적으로 즉시 열림)
            if (fromRoom.group && typeof fromRoom.group.traverse === 'function') {
                const doorsToRemove = [];
                const doorFramesToRemove = new Set();
                
                fromRoom.group.traverse((child) => {
                    if (child.userData) {
                        if (child.userData.isDoor && 
                            child.userData.direction === fromDirection &&
                            child.userData.gridX === fromGrid.x &&
                            child.userData.gridY === fromGrid.y) {
                            doorsToRemove.push(child);
                            if (child.userData.doorFrame) {
                                doorFramesToRemove.add(child.userData.doorFrame);
                            }
                        }
                        if (child.userData.isDoorFrame && child.userData.doorDirection === fromDirection) {
                            doorFramesToRemove.add(child);
                        }
                    }
                });
                
                // 문 제거
                doorsToRemove.forEach(doorToRemove => {
                    try {
                        removeDoorCompletelyFunc(doorToRemove);
                    } catch (error) {
                        console.error('AI 문 제거 오류:', error);
                    }
                });
                
                // 문 프레임 제거
                doorFramesToRemove.forEach(frameToRemove => {
                    try {
                        if (frameToRemove && frameToRemove.parent) {
                            frameToRemove.parent.remove(frameToRemove);
                            if (frameToRemove.material) {
                                frameToRemove.material.dispose();
                            }
                            if (frameToRemove.geometry) {
                                frameToRemove.geometry.dispose();
                            }
                        }
                    } catch (error) {
                        console.error('AI 문 프레임 제거 오류:', error);
                    }
                });
                
                // openedDoors에 추가
                const doorKey = `${fromGrid.x},${fromGrid.y},${fromDirection}`;
                gameState.openedDoors.add(doorKey);
            }
            
            // 플레이어의 현재 방에서도 같은 방향의 문 제거 (양방향 통과 가능하도록)
            // AI가 문을 열었을 때, 플레이어의 현재 방에서도 그 방향의 문이 열려있다면 시각적으로 제거
            const currentPlayerRoom = gameState.currentRoom;
            if (currentPlayerRoom && currentPlayerRoom.generated && currentPlayerRoom.group) {
                const playerRoomGrid = { x: currentPlayerRoom.gridX, y: currentPlayerRoom.gridY };
                
                // 현재 방의 모든 문을 확인하여 openedDoors에 있는 문은 시각적으로 제거
                currentPlayerRoom.doors.forEach((doorDir) => {
                    const doorKey = `${playerRoomGrid.x},${playerRoomGrid.y},${doorDir}`;
                    if (gameState.openedDoors.has(doorKey)) {
                        // 열려있는 문은 시각적으로 제거
                        const doorsToRemove = [];
                        const doorFramesToRemove = new Set();
                        
                        currentPlayerRoom.group.traverse((child) => {
                            if (child.userData) {
                                if (child.userData.isDoor && 
                                    child.userData.direction === doorDir &&
                                    child.userData.gridX === playerRoomGrid.x &&
                                    child.userData.gridY === playerRoomGrid.y) {
                                    doorsToRemove.push(child);
                                    if (child.userData.doorFrame) {
                                        doorFramesToRemove.add(child.userData.doorFrame);
                                    }
                                }
                                if (child.userData.isDoorFrame && child.userData.doorDirection === doorDir) {
                                    doorFramesToRemove.add(child);
                                }
                            }
                        });
                        
                        // 문 제거
                        doorsToRemove.forEach(doorToRemove => {
                            try {
                                if (doorToRemove.parent) {
                                    removeDoorCompletelyFunc(doorToRemove);
                                }
                            } catch (error) {
                                console.error('플레이어 방 문 제거 오류:', error);
                            }
                        });
                        
                        // 문 프레임 제거
                        doorFramesToRemove.forEach(frameToRemove => {
                            try {
                                if (frameToRemove && frameToRemove.parent) {
                                    frameToRemove.parent.remove(frameToRemove);
                                    if (frameToRemove.material) {
                                        frameToRemove.material.dispose();
                                    }
                                    if (frameToRemove.geometry) {
                                        frameToRemove.geometry.dispose();
                                    }
                                }
                            } catch (error) {
                                console.error('플레이어 방 문 프레임 제거 오류:', error);
                            }
                        });
                    }
                });
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
                        // 문 프레임의 material과 geometry도 정리
                        if (frameToRemove.material) {
                            frameToRemove.material.dispose();
                        }
                        if (frameToRemove.geometry) {
                            frameToRemove.geometry.dispose();
                        }
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

// AI 경로 업데이트 (꾸준히 재탐색)
function updateAIPath() {
    if (aiState.reached) return;
    
    // checkingPath가 true이면 이미 경로 탐색 중이므로 스킵 (너무 자주 호출 방지)
    // 하지만 0.5초 이상 경로 탐색 중이면 타임아웃으로 리셋 (더 빠르게)
    if (aiState.checkingPath) {
        const now = Date.now();
        if (now - aiState.lastPathCheckTime > 500) {
            console.log('AI checkingPath 타임아웃, 강제 리셋');
            aiState.checkingPath = false;
        } else {
            return; // 아직 경로 탐색 중
        }
    }
    
    // 목표 그리드에 도달했는지 확인 (실제 체크포인트 도달은 checkGameEnd에서 확인)
    // 그리드 도달 후에도 실제 체크포인트 위치까지 이동하도록 경로 탐색을 계속함
    
    const now = Date.now();
    const timeSinceLastCheck = now - aiState.lastPathCheckTime;
    // 경로를 꾸준히 재탐색 (경로가 없거나 끝에 도달했을 때는 즉시, 그 외에는 3초마다)
    const shouldCheck = aiState.path.length === 0 || 
                        aiState.currentPathIndex >= aiState.path.length ||
                        timeSinceLastCheck >= 3000; // 3초마다 재탐색 (정상 이동 중에는 덜 자주)
    
    if (shouldCheck) {
        aiState.checkingPath = true;
        aiState.lastPathCheckTime = now;
        
        // 현재 위치에서 목표로 직접 가는 경로 계산
        const newPath = findPath(
            aiState.position.x, 
            aiState.position.y,
            aiState.targetPosition.x,
            aiState.targetPosition.y
        );
        
        if (newPath && newPath.length > 0) {
            aiState.path = newPath;
            aiState.currentPathIndex = 1; // 시작점 제외
            console.log('AI 경로 탐색 완료:', newPath);
        } else {
            // 경로를 찾을 수 없으면 목표 방향으로 새 방 생성하여 이동
            console.log('AI 경로를 찾을 수 없습니다. 목표 방향으로 새 방 생성 시도...');
            
            // 목표 방향 계산
            const targetX = aiState.targetPosition.x;
            const targetY = aiState.targetPosition.y;
            
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
            
            // 목표 그리드에 도달했는지 확인
            if (dx === 0 && dy === 0) {
                // 이미 목표 그리드에 도달 (실제 체크포인트 도달은 checkGameEnd에서 확인)
                console.log('AI가 목표 그리드에 도달했습니다. (경로 탐색 실패 시)');
                aiState.path = [];
                aiState.currentPathIndex = 0;
                aiState.checkingPath = false;
                return;
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
                        // 경로를 찾을 수 없어도 포기하지 않고 다음에 다시 시도
                        // 경로를 빈 배열로 두면 다음 프레임에 다시 경로 탐색 시도
                        aiState.path = [];
                        aiState.currentPathIndex = 0;
                    } else {
                        // 방 생성 쿨다운 중이면 다음에 다시 시도
                        console.log('AI 방 생성 쿨다운 중, 다음에 다시 시도');
                        aiState.path = [];
                        aiState.currentPathIndex = 0;
                    }
                }
            } else {
                // 그리드 범위를 벗어나면 경로를 찾을 수 없음
                console.log('AI 목표가 그리드 범위를 벗어남');
                aiState.path = [];
                aiState.currentPathIndex = 0;
            }
        }
        
        aiState.checkingPath = false;
    }
}

// AI 이동 업데이트
let lastMovementUpdate = 0;

function updateAIMovement() {
    if (!aiState.mesh) return;
    
    // reached가 true여도 실제 체크포인트 위치까지 이동하도록 허용
    // checkGameEnd에서 실제 체크포인트 도달을 확인함
    
    const now = Date.now();
    
    // 경로가 없으면 경로 재탐색 시도 또는 목표 그리드에 도달했으면 체크포인트로 이동
    if (aiState.path.length === 0) {
        // 목표 그리드에 도달했으면 체크포인트 위치로 직접 이동
        if (aiState.position.x === aiState.targetPosition.x && 
            aiState.position.y === aiState.targetPosition.y) {
            const gameState = window.gameState;
            if (gameState && gameState.aiCheckpoint) {
                const checkpointPos = gameState.aiCheckpoint.position;
                const currentWorldX = aiState.mesh.position.x;
                const currentWorldZ = aiState.mesh.position.z;
                const targetWorldX = checkpointPos.x;
                const targetWorldZ = checkpointPos.z;
                
                const distX = targetWorldX - currentWorldX;
                const distZ = targetWorldZ - currentWorldZ;
                const distance = Math.sqrt(distX * distX + distZ * distZ);
                
                if (distance > 0.1) {
                    // 체크포인트 방향으로 이동 (방 경계 체크 없이 직접 이동)
                    const moveX = (distX / distance) * aiState.speed;
                    const moveZ = (distZ / distance) * aiState.speed;
                    aiState.mesh.position.x += moveX;
                    aiState.mesh.position.z += moveZ;
                }
                lastMovementUpdate = now;
                return;
            }
        }
        updateAIPath(); // checkingPath 체크는 updateAIPath 내부에서 처리
        lastMovementUpdate = now;
        return; // 경로가 없으면 이동 불가
    }
    
    // 현재 방이 생성되어 있는지 확인 (없으면 생성 불가능하므로 경로 재탐색)
    const currentKey = `${aiState.position.x},${aiState.position.y}`;
    const currentRoom = window.gameState?.rooms.get(currentKey);
    if (!currentRoom || !currentRoom.generated) {
        // 현재 방이 없으면 경로 재탐색
        console.log('AI 현재 방이 없음, 경로 재탐색');
        aiState.path = [];
        aiState.currentPathIndex = 0;
        updateAIPath();
        lastMovementUpdate = now;
        return;
    }
    
    if (aiState.currentPathIndex >= aiState.path.length) {
        // 경로의 끝에 도달했지만 목표가 아닐 수 있음
        // 목표 그리드에 도달했는지 확인
        if (aiState.position.x === aiState.targetPosition.x && 
            aiState.position.y === aiState.targetPosition.y) {
            // 목표 그리드에 도달했으면 체크포인트 위치로 직접 이동
            const gameState = window.gameState;
            if (gameState && gameState.aiCheckpoint) {
                const checkpointPos = gameState.aiCheckpoint.position;
                const currentWorldX = aiState.mesh.position.x;
                const currentWorldZ = aiState.mesh.position.z;
                const targetWorldX = checkpointPos.x;
                const targetWorldZ = checkpointPos.z;
                
                const distX = targetWorldX - currentWorldX;
                const distZ = targetWorldZ - currentWorldZ;
                const distance = Math.sqrt(distX * distX + distZ * distZ);
                
                if (distance > 0.1) {
                    // 체크포인트 방향으로 이동
                    const moveX = (distX / distance) * aiState.speed;
                    const moveZ = (distZ / distance) * aiState.speed;
                    aiState.mesh.position.x += moveX;
                    aiState.mesh.position.z += moveZ;
                }
            }
            // 경로는 비워서 더 이상 경로 탐색하지 않음
            aiState.path = [];
            aiState.currentPathIndex = 0;
            lastMovementUpdate = now;
            return;
        }
        // 목표가 아니면 목표 방향으로 직접 이동 시도
        const dx = aiState.targetPosition.x - aiState.position.x;
        const dy = aiState.targetPosition.y - aiState.position.y;
        
        // 목표 방향 계산
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
        
        // 목표 방향으로 방이 있는지 확인
        const targetKey = `${nextX},${nextY}`;
        const targetRoom = window.gameState?.rooms.get(targetKey);
        
        // 방이 없거나 생성되지 않았으면 생성 시도
        if ((!targetRoom || !targetRoom.generated) && direction !== -1 && 
            nextX >= -2 && nextX <= 2 && nextY >= -4 && nextY <= 4 &&
            now - aiState.lastRoomCreateTime >= aiState.roomCreateCooldown) {
            console.log(`AI 경로 끝, 목표 방향으로 방 생성 시도: (${nextX}, ${nextY})`);
            const created = aiCreateRoom(nextX, nextY, direction);
            if (created) {
                aiState.path = [
                    { x: aiState.position.x, y: aiState.position.y },
                    { x: nextX, y: nextY }
                ];
                aiState.currentPathIndex = 1;
                aiState.lastRoomCreateTime = now;
                console.log('AI 목표 방향으로 방 생성 성공');
            } else {
                // 방 생성 실패 시 경로 재탐색
                updateAIPath();
            }
        } else if (targetRoom && targetRoom.generated) {
            // 방이 이미 있으면 경로에 추가
            aiState.path = [
                { x: aiState.position.x, y: aiState.position.y },
                { x: nextX, y: nextY }
            ];
            aiState.currentPathIndex = 1;
            console.log('AI 목표 방향 방 발견, 경로에 추가');
        } else {
            // 그 외의 경우 경로 재탐색
            updateAIPath();
        }
        lastMovementUpdate = now;
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
                    // 모든 방향 실패 시 경로 재탐색 (즉시)
                    console.log('AI 모든 방향으로 방 생성 실패, 경로 재탐색');
                    aiState.path = [];
                    aiState.currentPathIndex = 0;
                    updateAIPath(); // 즉시 재탐색
                    lastMovementUpdate = now;
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
                // 모든 방향 실패 시 경로 재탐색 (즉시)
                console.log('AI 모든 방향으로 방 생성 실패, 경로 재탐색');
                aiState.path = [];
                aiState.currentPathIndex = 0;
                updateAIPath(); // 즉시 재탐색
                lastMovementUpdate = now;
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
        
        // 목표 그리드에 도달했는지 확인
        if (aiState.position.x === aiState.targetPosition.x && 
            aiState.position.y === aiState.targetPosition.y) {
            // 목표 그리드에 도달했으면 체크포인트 위치로 직접 이동
            const gameState = window.gameState;
            if (gameState && gameState.aiCheckpoint) {
                const checkpointPos = gameState.aiCheckpoint.position;
                const currentWorldX = aiState.mesh.position.x;
                const currentWorldZ = aiState.mesh.position.z;
                const targetWorldX = checkpointPos.x;
                const targetWorldZ = checkpointPos.z;
                
                const distX = targetWorldX - currentWorldX;
                const distZ = targetWorldZ - currentWorldZ;
                const distance = Math.sqrt(distX * distX + distZ * distZ);
                
                if (distance > 0.1) {
                    // 체크포인트 방향으로 이동
                    const moveX = (distX / distance) * aiState.speed;
                    const moveZ = (distZ / distance) * aiState.speed;
                    aiState.mesh.position.x += moveX;
                    aiState.mesh.position.z += moveZ;
                }
            }
            // 경로는 비워서 더 이상 경로 탐색하지 않음
            aiState.path = [];
            aiState.currentPathIndex = 0;
            return;
        }
        
        // 다음 경로를 위해 업데이트
        if (aiState.currentPathIndex >= aiState.path.length) {
            updateAIPath();
        }
    } else {
        // 목표 방향으로 이동 (방 경계 체크 포함)
        const moveX = (distX / distance) * aiState.speed;
        const moveZ = (distZ / distance) * aiState.speed;
        
        // 방 경계 체크
        const ROOM_SIZE = window.ROOM_SIZE || 8;
        const DOOR_WIDTH = 1.5;
        const roomCenterX = aiState.position.x * ROOM_SIZE;
        const roomCenterZ = aiState.position.y * ROOM_SIZE;
        const halfSize = ROOM_SIZE / 2 - 0.5;
        
        // 기본 경계
        let xMin = roomCenterX - halfSize;
        let xMax = roomCenterX + halfSize;
        let zMin = roomCenterZ - halfSize;
        let zMax = roomCenterZ + halfSize;
        
        // 열린 문 방향 확인
        const doorHalfWidth = DOOR_WIDTH / 2;
        const gameState = window.gameState;
        const getTargetGridFunc = window.getTargetGrid;
        
        if (currentRoom && currentRoom.doors && getTargetGridFunc) {
            currentRoom.doors.forEach((doorDir) => {
                const doorKey = `${currentRoom.gridX},${currentRoom.gridY},${doorDir}`;
                const targetGrid = getTargetGridFunc(currentRoom.gridX, currentRoom.gridY, doorDir);
                const targetRoom = gameState?.rooms.get(`${targetGrid.x},${targetGrid.y}`);
                
                // 문이 열려있는지 확인
                const isOpen = gameState?.openedDoors?.has(doorKey) || 
                              (targetRoom && targetRoom.generated && 
                               gameState?.openedDoors?.has(`${targetGrid.x},${targetGrid.y},${(doorDir + 2) % 4}`));
                
                if (isOpen && targetRoom && targetRoom.generated) {
                    const margin = 2.0;
                    
                    if (doorDir === 0) { // 북
                        const doorXMin = roomCenterX - doorHalfWidth;
                        const doorXMax = roomCenterX + doorHalfWidth;
                        if (aiState.mesh.position.x >= doorXMin && aiState.mesh.position.x <= doorXMax) {
                            zMin = Math.min(zMin, roomCenterZ - halfSize - margin);
                        }
                    } else if (doorDir === 1) { // 동
                        const doorZMin = roomCenterZ - doorHalfWidth;
                        const doorZMax = roomCenterZ + doorHalfWidth;
                        if (aiState.mesh.position.z >= doorZMin && aiState.mesh.position.z <= doorZMax) {
                            xMax = Math.max(xMax, roomCenterX + halfSize + margin);
                        }
                    } else if (doorDir === 2) { // 남
                        const doorXMin = roomCenterX - doorHalfWidth;
                        const doorXMax = roomCenterX + doorHalfWidth;
                        if (aiState.mesh.position.x >= doorXMin && aiState.mesh.position.x <= doorXMax) {
                            zMax = Math.max(zMax, roomCenterZ + halfSize + margin);
                        }
                    } else if (doorDir === 3) { // 서
                        const doorZMin = roomCenterZ - doorHalfWidth;
                        const doorZMax = roomCenterZ + doorHalfWidth;
                        if (aiState.mesh.position.z >= doorZMin && aiState.mesh.position.z <= doorZMax) {
                            xMin = Math.min(xMin, roomCenterX - halfSize - margin);
                        }
                    }
                }
            });
        }
        
        // 경계 제한 적용 (낑김 방지를 위해 약간의 여유 공간 추가)
        const newX = Math.max(xMin, Math.min(xMax, aiState.mesh.position.x + moveX));
        const newZ = Math.max(zMin, Math.min(zMax, aiState.mesh.position.z + moveZ));
        
        // 경계에 낑겼는지 확인 (이동하려는 방향과 실제 이동한 거리 비교)
        const actualMoveX = newX - aiState.mesh.position.x;
        const actualMoveZ = newZ - aiState.mesh.position.z;
        const expectedMoveX = moveX;
        const expectedMoveZ = moveZ;
        
        // 예상 이동과 실제 이동이 크게 다르면 경계에 낑긴 것
        const moveDiffX = Math.abs(actualMoveX - expectedMoveX);
        const moveDiffZ = Math.abs(actualMoveZ - expectedMoveZ);
        const moveThreshold = 0.01; // 작은 차이는 무시
        
        // 경계에 낑겼는지 확인 (더 엄격한 조건)
        const isStuck = (moveDiffX > moveThreshold || moveDiffZ > moveThreshold) && 
                        (Math.abs(moveX) > 0.001 || Math.abs(moveZ) > 0.001);
        
        if (isStuck) {
            // 목표 방향으로 이동할 수 없으므로 경로 재계산
            const targetDirX = Math.sign(distX);
            const targetDirZ = Math.sign(distZ);
            const blockedX = Math.abs(actualMoveX) < Math.abs(expectedMoveX) * 0.3 && Math.abs(moveX) > 0.001;
            const blockedZ = Math.abs(actualMoveZ) < Math.abs(expectedMoveZ) * 0.3 && Math.abs(moveZ) > 0.001;
            
            // 경계에 막혔고 목표 방향으로 이동할 수 없으면 낑김 카운트 증가
            if ((blockedX && targetDirX !== 0) || (blockedZ && targetDirZ !== 0)) {
                aiState.stuckFrames++;
                
                // 연속으로 20프레임 이상 낑겼을 때만 경로 재탐색 (너무 자주 재탐색 방지)
                if (aiState.stuckFrames >= 20) {
                    console.log('AI 경계에 낑김 (연속 ' + aiState.stuckFrames + '프레임), 경로 재탐색');
                    aiState.path = [];
                    aiState.currentPathIndex = 0;
                    aiState.stuckFrames = 0; // 리셋
                    updateAIPath();
                    lastMovementUpdate = now;
                    return;
                }
            } else {
                // 낑긴 게 아니면 카운트 리셋
                aiState.stuckFrames = 0;
            }
        } else {
            // 정상 이동 중이면 카운트 리셋
            aiState.stuckFrames = 0;
        }
        
        aiState.mesh.position.x = newX;
        aiState.mesh.position.z = newZ;
        
        // 방 경계를 넘었는지 확인하고 방 전환
        const threshold = 0.5;
        if (direction !== -1) {
            let passed = false;
            if (direction === 0) { // 북
                passed = aiState.mesh.position.z <= roomCenterZ - halfSize + threshold;
            } else if (direction === 1) { // 동
                passed = aiState.mesh.position.x >= roomCenterX + halfSize - threshold;
            } else if (direction === 2) { // 남
                passed = aiState.mesh.position.z >= roomCenterZ + halfSize - threshold;
            } else if (direction === 3) { // 서
                passed = aiState.mesh.position.x <= roomCenterX - halfSize + threshold;
            }
            
            if (passed && targetRoom && targetRoom.generated) {
                // 문의 폭 범위 내에 있는지 확인
                let inDoorRange = false;
                if (direction === 0 || direction === 2) { // 북/남
                    inDoorRange = aiState.mesh.position.x >= roomCenterX - doorHalfWidth && 
                                 aiState.mesh.position.x <= roomCenterX + doorHalfWidth;
                } else { // 동/서
                    inDoorRange = aiState.mesh.position.z >= roomCenterZ - doorHalfWidth && 
                                 aiState.mesh.position.z <= roomCenterZ + doorHalfWidth;
                }
                
                if (inDoorRange && (aiState.position.x !== currentTarget.x || aiState.position.y !== currentTarget.y)) {
                    // 방 전환: 새로운 방에 들어감
                    aiState.position = { x: currentTarget.x, y: currentTarget.y };
                    aiState.currentPathIndex++;
                    
                    // 목표 그리드에 도달했는지 확인
                    if (aiState.position.x === aiState.targetPosition.x && 
                        aiState.position.y === aiState.targetPosition.y) {
                        // 목표 그리드에 도달했으면 체크포인트 위치로 직접 이동
                        const gameState = window.gameState;
                        if (gameState && gameState.aiCheckpoint) {
                            const checkpointPos = gameState.aiCheckpoint.position;
                            const currentWorldX = aiState.mesh.position.x;
                            const currentWorldZ = aiState.mesh.position.z;
                            const targetWorldX = checkpointPos.x;
                            const targetWorldZ = checkpointPos.z;
                            
                            const distX = targetWorldX - currentWorldX;
                            const distZ = targetWorldZ - currentWorldZ;
                            const distance = Math.sqrt(distX * distX + distZ * distZ);
                            
                            if (distance > 0.1) {
                                // 체크포인트 방향으로 이동
                                const moveX = (distX / distance) * aiState.speed;
                                const moveZ = (distZ / distance) * aiState.speed;
                                aiState.mesh.position.x += moveX;
                                aiState.mesh.position.z += moveZ;
                            }
                        }
                        // 경로는 비워서 더 이상 경로 탐색하지 않음
                        aiState.path = [];
                        aiState.currentPathIndex = 0;
                        return;
                    }
                    
                    // 다음 경로 업데이트
                    if (aiState.currentPathIndex >= aiState.path.length) {
                        updateAIPath();
                    }
                }
            }
        }
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
    
    // 체크포인트를 목표로 설정
    if (gameState.aiCheckpoint) {
        aiState.targetPosition = { 
            x: gameState.aiCheckpoint.gridX, 
            y: gameState.aiCheckpoint.gridY 
        };
        console.log('AI 목표 설정 (체크포인트):', aiState.targetPosition);
    } else {
        // 체크포인트가 없으면 기본값 사용
        aiState.targetPosition = { x: 0, y: 4 };
        console.log('AI 목표 설정 (기본값):', aiState.targetPosition);
    }
    
    // AI 상태를 window에 노출 (미니맵 표시를 위해)
    window.aiState = aiState;
    
    console.log('AI 초기화 완료, 위치:', aiState.position, '목표:', aiState.targetPosition);
    
    // 경로 탐색 시작
    setTimeout(() => {
        updateAIPath();
    }, 1000); // 1초 후 경로 탐색 시작
}

// window에 노출
window.initAI = initAI;
window.updateAI = updateAI;
window.damageAI = damageAI;


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
    
    // 게임 종료 체크 (game.js의 checkGameEnd 호출)
    if (window.checkGameEnd && typeof window.checkGameEnd === 'function') {
        window.checkGameEnd();
    }
}

// AI 업데이트 (애니메이션 루프에서 호출)
let lastAIPathUpdate = 0;

function updateAI() {
    if (!aiState.mesh) return;
    
    const now = Date.now();
    
    // 경로 업데이트는 updateAIMovement 내부에서 필요할 때만 호출
    // 여기서는 주기적으로만 체크 (3초마다)
    if (now - aiState.lastPathCheckTime >= 3000) {
        updateAIPath();
    }
    
    updateAIMovement();
}

