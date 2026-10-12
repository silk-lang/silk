const storageAcquire = 'Intrinsic.systemAllocationAcquire'

/**
 * Keeps low-level allocation-origin fixtures focused on provenance while adapting the sealed
 * storage refusal into the ordinary source allocation error. The compiler never recognizes the
 * adapter names; this is the same policy boundary implemented by `silk/allocator.SystemAllocator`.
 */
export const ordinaryStorageSource = (source: string): string => {
  if (!source.includes(storageAcquire)) return source
  return `import silk.allocator { OutOfMemoryError }
import silk.layout { Layout }
${source.replaceAll(storageAcquire, 'testStorageAcquire')}
effect fn testStorageRefused(
  error: Intrinsic.StorageFailure
) -> Intrinsic.Allocation ! OutOfMemoryError {
  drop error
  fail OutOfMemoryError {}
}
effect fn testRawStorageAcquire(
  layout: Layout
) -> Intrinsic.Allocation ! Intrinsic.StorageFailure {
  return run Intrinsic.systemAllocationAcquire(move layout)
}
effect fn testStorageAcquire(
  layout: Layout
) -> Intrinsic.Allocation ! OutOfMemoryError {
  return run Intrinsic.catchFailure<Intrinsic.StorageFailure>(
    testRawStorageAcquire(move layout),
    testStorageRefused
  )
}`
}
