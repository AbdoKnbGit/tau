import { ARTIFACT_CANVAS_TOOL_NAME } from '../tools/ArtifactCanvasTool/constants.js'
import { BROWSER_TOOL_NAME } from '../tools/BrowserTool/constants.js'
import { CHANGE_RISK_TOOL_NAME } from '../tools/ChangeRiskTool/constants.js'
import { INSPECT_SITE_TOOL_NAME } from '../tools/InspectSiteTool/constants.js'
import { NATIVE_SYSINFO_TOOL_NAME } from '../tools/NativeTools/constants.js'
import { PACKAGE_MANAGER_TOOL_NAME } from '../tools/PackageManagerTool/constants.js'
import { PROJECT_WORKFLOW_TOOL_NAME } from '../tools/ProjectWorkflowTool/constants.js'
import { VISUAL_DESIGN_AUDIT_TOOL_NAME } from '../tools/VisualDesignAuditTool/constants.js'
import { WEB_BROWSER_TOOL_NAME } from '../tools/WebBrowserTool/constants.js'

export type PrebuiltToolToggleItem = {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly purpose: string
  readonly toolNames: readonly string[]
}

export type PrebuiltToolToggleGroup = {
  readonly label: string
  readonly items: readonly PrebuiltToolToggleItem[]
}

export const PREBUILT_TOOL_TOGGLE_GROUPS = [
  {
    label: 'Project & Workflow',
    items: [
      {
        id: PROJECT_WORKFLOW_TOOL_NAME,
        purpose: 'Return repo-native build, lint, test, dev, preview, and deploy commands.',
        toolNames: [PROJECT_WORKFLOW_TOOL_NAME],
      },
      {
        id: PACKAGE_MANAGER_TOOL_NAME,
        purpose: 'Detect the package manager and suggest safe package commands.',
        toolNames: [PACKAGE_MANAGER_TOOL_NAME],
      },
    ],
  },
  {
    label: 'Testing & Verification',
    items: [
      {
        // Deferred, so it costs a name rather than a schema until loaded — but
        // it was previously the only optional tool with no way to turn it off.
        // Cheap mode already drops it: CHEAP_MODE_CORE_TOOL_NAME_SET does not
        // list it, and that filter runs before this one.
        id: CHANGE_RISK_TOOL_NAME,
        purpose: 'Analyze diffs to determine risk levels.',
        toolNames: [CHANGE_RISK_TOOL_NAME],
      },
      {
        id: INSPECT_SITE_TOOL_NAME,
        purpose: 'Verify HTTP pages, expected text, assets, and simple forms.',
        toolNames: [INSPECT_SITE_TOOL_NAME],
      },
      {
        id: WEB_BROWSER_TOOL_NAME,
        purpose:
          'Open URLs/local files in the native browser or capture compact HTTP/local HTML snapshots.',
        toolNames: [WEB_BROWSER_TOOL_NAME],
      },
      {
        id: BROWSER_TOOL_NAME,
        purpose:
          'Drive a real Chrome/Edge browser: navigate, read the page as numbered elements, click, fill, type, scroll, screenshot, and manage tabs.',
        toolNames: [BROWSER_TOOL_NAME],
      },
      {
        id: VISUAL_DESIGN_AUDIT_TOOL_NAME,
        purpose: 'Scan frontend styling risks and visual verification needs.',
        toolNames: [VISUAL_DESIGN_AUDIT_TOOL_NAME],
      },
      {
        id: NATIVE_SYSINFO_TOOL_NAME,
        purpose: 'Return local CPU, memory, disk, load, and process summary.',
        toolNames: [NATIVE_SYSINFO_TOOL_NAME],
      },
    ],
  },
  {
    label: 'Artifacts',
    items: [
      {
        id: ARTIFACT_CANVAS_TOOL_NAME,
        purpose:
          'Create browser-reviewable HTML artifacts for reports, previews, mockups, and canvases.',
        toolNames: [ARTIFACT_CANVAS_TOOL_NAME],
      },
    ],
  },
] as const satisfies readonly PrebuiltToolToggleGroup[]

// `[...group.items]` rather than `group.items`: `as const` makes each group's
// items a readonly tuple, and flatMap cannot resolve its overload against a
// union of tuples of differing length once a group holds a single item.
// Spreading yields a plain array while preserving the literal `id` types that
// `PrebuiltToolToggleId` is derived from.
export const PREBUILT_TOOL_TOGGLE_ITEMS = PREBUILT_TOOL_TOGGLE_GROUPS.flatMap(
  group => [...group.items],
)

export type PrebuiltToolToggleId =
  (typeof PREBUILT_TOOL_TOGGLE_ITEMS)[number]['id']

export function getPrebuiltToolToggleItem(
  value: string,
): PrebuiltToolToggleItem | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined

  return PREBUILT_TOOL_TOGGLE_ITEMS.find(entry => {
    // Widened deliberately. `as const` narrows the union to the shapes that
    // actually ship, and since AFT was removed no toggle declares `aliases`
    // any more — so the literal union no longer carries the property even
    // though `PrebuiltToolToggleItem` still allows it. Reading through the
    // declared type keeps the alias branch working for the next toggle that
    // bundles tools, rather than deleting a supported feature to satisfy
    // inference.
    const item: PrebuiltToolToggleItem = entry
    if (item.id.toLowerCase() === normalized) return true
    if (item.toolNames.some(name => name.toLowerCase() === normalized)) {
      return true
    }
    return item.aliases?.some(alias => alias.toLowerCase() === normalized)
  })
}

