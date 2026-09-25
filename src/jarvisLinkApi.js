/*
  RESOURCE LINK V1 — canonical 쓰기 공용 래퍼 (M2).

  Task↔File 링크는 사용자의 명시적 UI 행동으로만 생성된다 — AI가 자동으로
  영속 관계를 만들지 않는다(V4 §13-C). 브리지가 task/FileRef/relation을
  검증하고 resource_links.json에 identity와 관계 의미만 저장한다.

  useJarvisTree(컨텍스트 트리 팝오버)와 App(어시스턴트 Active File 연결)이
  같은 경로를 쓰게 하기 위해 정규화를 여기 한 곳에 둔다.
*/

const getDiscoveryApi = () => window.jarvisDiscovery || null

const apiMissing = (name) =>
  `jarvisDiscovery.${name} API 없음 — Electron을 재시작하세요.`

const trimOr = (value, fallback = '') =>
  typeof value === 'string' ? value.trim() : fallback

export async function linkTaskFile({ taskId, fileId, relation }) {
  const api = getDiscoveryApi()
  if (!api?.linkTaskFile) {
    return { ok: false, error: apiMissing('linkTaskFile') }
  }
  const tid = trimOr(taskId)
  const fid = trimOr(fileId)
  if (!tid) return { ok: false, error: 'task_id가 비어 있습니다' }
  if (!fid) return { ok: false, error: 'file_id(FileRef identity)가 비어 있습니다' }
  const response = await api.linkTaskFile(
    tid,
    fid,
    trimOr(relation, 'reference') || 'reference',
  )
  if (!response || response.status !== 'ok') {
    return { ok: false, error: response?.error || 'Task 리소스 연결에 실패했습니다' }
  }
  return { ok: true, created: response.created, link: response.link }
}

export async function linkProjectFile({ projectId, fileId, relation }) {
  const api = getDiscoveryApi()
  if (!api?.linkProjectFile) {
    return { ok: false, error: apiMissing('linkProjectFile') }
  }
  const pid = trimOr(projectId)
  const fid = trimOr(fileId)
  if (!pid) return { ok: false, error: 'project_id가 비어 있습니다' }
  if (!fid) return { ok: false, error: 'file_id(FileRef identity)가 비어 있습니다' }
  const response = await api.linkProjectFile(
    pid,
    fid,
    trimOr(relation, 'reference') || 'reference',
  )
  if (!response || response.status !== 'ok') {
    return { ok: false, error: response?.error || '링크 생성에 실패했습니다' }
  }
  return { ok: true, created: response.created, link: response.link }
}

export async function unlinkTaskFile({ linkId }) {
  const api = getDiscoveryApi()
  if (!api?.unlinkTaskFile) {
    return { ok: false, error: apiMissing('unlinkTaskFile') }
  }
  const lid = trimOr(linkId)
  if (!lid) return { ok: false, error: 'link_id가 비어 있습니다' }
  const response = await api.unlinkTaskFile(lid)
  if (!response || response.status !== 'ok') {
    return {
      ok: false,
      error: response?.error || 'Task 리소스 연결 해제에 실패했습니다',
    }
  }
  return { ok: true, removed: response.removed, link: response.link }
}
