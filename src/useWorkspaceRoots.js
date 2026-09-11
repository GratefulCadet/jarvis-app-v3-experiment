import { useCallback, useEffect, useState } from 'react'

/*
  Workspace root management hook — extracted from TreePrototype.

  Owns:
  - root list / loading / errors
  - add folder (picker → register)
  - reconnect (picker → update device_path)
  - rename display_name
  - remove (with dependency error display)
  - refresh after mutations
  - Settings dialog open state

  Does NOT own:
  - Project ↔ Workspace connect (lives in TreePrototype, uses picker + bridge)
  - FILES refresh (lives in TreePrototype via useJarvisFiles)
  - SYSTEM MAP rendering
*/

export default function useWorkspaceRoots({ taskTree, files }) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [wsRoots, setWsRoots] = useState([])
  const [wsRootsError, setWsRootsError] = useState(null)
  const [wsRootsBusy, setWsRootsBusy] = useState(false)
  const [editingRootId, setEditingRootId] = useState(null)
  const [editingName, setEditingName] = useState('')

  const loadWorkspaceRoots = useCallback(async () => {
    if (!taskTree?.listWorkspaceRoots) return
    try {
      const res = await taskTree.listWorkspaceRoots()
      if (res?.status === 'ok' && Array.isArray(res.roots)) {
        setWsRoots(res.roots)
      }
    } catch {
      // Settings dialog is best-effort
    }
  }, [taskTree])

  useEffect(() => {
    if (!settingsOpen) return undefined
    let cancelled = false
    ;(async () => {
      await loadWorkspaceRoots()
      if (cancelled) return
    })()
    return () => { cancelled = true }
  }, [settingsOpen, loadWorkspaceRoots])

  const handleAddFolder = useCallback(async () => {
    if (wsRootsBusy) return
    setWsRootsBusy(true)
    setWsRootsError(null)
    try {
      const picked = await taskTree.pickFolder()
      if (!picked || !picked.ok) {
        setWsRootsError(picked?.error || '폴더 선택에 실패했습니다')
        return
      }
      if (picked.cancelled) return
      const result = await taskTree.registerWorkspaceRoot({ devicePath: picked.path })
      if (!result || !result.ok) {
        setWsRootsError(result?.error || 'workspace 등록에 실패했습니다')
        return
      }
      const refreshResult = await files?.refresh?.()
      if (refreshResult && !refreshResult.ok) {
        setWsRootsError('등록은 완료되었으나 파일 뷰 새로고침에 실패했습니다. 다시 시도해주세요.')
      }
      await loadWorkspaceRoots()
    } catch (exception) {
      setWsRootsError(String(exception?.message || exception))
    } finally {
      setWsRootsBusy(false)
    }
  }, [wsRootsBusy, taskTree, files, loadWorkspaceRoots])

  const handleRenameRoot = useCallback(async (rootId) => {
    const trimmed = editingName.trim()
    if (!trimmed) return
    setWsRootsBusy(true)
    setWsRootsError(null)
    try {
      const result = await taskTree.updateWorkspaceRoot({ rootId, displayName: trimmed })
      if (!result || !result.ok) {
        setWsRootsError(result?.error || '이름 변경에 실패했습니다')
        return
      }
      const refreshResult = await files?.refresh?.()
      if (refreshResult && !refreshResult.ok) {
        setWsRootsError('이름 변경은 완료되었으나 파일 뷰 새로고침에 실패했습니다.')
      }
      setEditingRootId(null)
      setEditingName('')
      await loadWorkspaceRoots()
    } catch (exception) {
      setWsRootsError(String(exception?.message || exception))
    } finally {
      setWsRootsBusy(false)
    }
  }, [editingName, taskTree, files, loadWorkspaceRoots])

  const handleReconnectRoot = useCallback(async (rootId) => {
    setWsRootsBusy(true)
    setWsRootsError(null)
    try {
      const picked = await taskTree.pickFolder()
      if (!picked || !picked.ok) {
        setWsRootsError(picked?.error || '폴더 선택에 실패했습니다')
        return
      }
      if (picked.cancelled) return
      const result = await taskTree.updateWorkspaceRoot({ rootId, devicePath: picked.path })
      if (!result || !result.ok) {
        setWsRootsError(result?.error || '재연결에 실패했습니다')
        return
      }
      const refreshResult = await files?.refresh?.()
      if (refreshResult && !refreshResult.ok) {
        setWsRootsError('재연결은 완료되었으나 파일 뷰 새로고침에 실패했습니다. 다시 시도해주세요.')
      }
      await loadWorkspaceRoots()
    } catch (exception) {
      setWsRootsError(String(exception?.message || exception))
    } finally {
      setWsRootsBusy(false)
    }
  }, [taskTree, files, loadWorkspaceRoots])

  const handleRemoveRoot = useCallback(async (rootId) => {
    setWsRootsBusy(true)
    setWsRootsError(null)
    try {
      const result = await taskTree.removeWorkspaceRoot({ rootId })
      if (!result || !result.ok) {
        setWsRootsError(result?.error || '제거에 실패했습니다')
        return
      }
      const refreshResult = await files?.refresh?.()
      if (refreshResult && !refreshResult.ok) {
        setWsRootsError('제거는 완료되었으나 파일 뷰 새로고침에 실패했습니다.')
      }
      await loadWorkspaceRoots()
    } catch (exception) {
      setWsRootsError(String(exception?.message || exception))
    } finally {
      setWsRootsBusy(false)
    }
  }, [taskTree, files, loadWorkspaceRoots])

  return {
    settingsOpen,
    setSettingsOpen,
    wsRoots,
    wsRootsError,
    setWsRootsError,
    wsRootsBusy,
    editingRootId,
    setEditingRootId,
    editingName,
    setEditingName,
    loadWorkspaceRoots,
    handleAddFolder,
    handleRenameRoot,
    handleReconnectRoot,
    handleRemoveRoot,
  }
}
