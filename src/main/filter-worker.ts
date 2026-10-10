// Runs in an Electron utility process: parses filter lists into a compact, serialized engine.
// Parsing ~150k filters takes a few seconds of CPU and a lot of transient memory, so it must
// stay out of the main process. The main process only deserializes the result (tens of ms).
import { FiltersEngine } from '@ghostery/adblocker'

interface Job {
  lists: string[]
  resources: string | null
}

process.parentPort.once('message', (event: { data: Job }) => {
  const { lists, resources } = event.data
  const engine = FiltersEngine.parse(lists.join('\n'), {
    loadNetworkFilters: true,
    loadCosmeticFilters: true,
    // Smaller in memory at a negligible matching cost.
    enableCompression: true,
  })
  if (resources) engine.updateResources(resources, String(resources.length))
  process.parentPort.postMessage(engine.serialize())
  process.exit(0)
})
