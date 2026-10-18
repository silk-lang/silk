import type * as BuilderState from '../internal/BuilderState.js'
import type * as TypeDescription from '../internal/TypeDescription.js'
import { identifier, quoted } from './shared.js'

/** @internal */
export const typeAt = (
  state: BuilderState.Snapshot,
  index: number,
): TypeDescription.Description => {
  const description = state.types[index]
  if (description === undefined) throw new Error(`missing type ${index}`)
  return description
}

/** @internal */
export const renderType = (state: BuilderState.Snapshot, index: number): string => {
  const description = typeAt(state, index)
  if (description._tag === 'Simple') {
    switch (description.tag) {
      case 'Void':
        return 'void'
      case 'Half':
        return 'half'
      case 'BFloat':
        return 'bfloat'
      case 'Float':
        return 'float'
      case 'Double':
        return 'double'
      case 'X86Fp80':
        return 'x86_fp80'
      case 'Fp128':
        return 'fp128'
      case 'PpcFp128':
        return 'ppc_fp128'
      case 'Label':
        return 'label'
      case 'Metadata':
        return 'metadata'
      case 'X86Amx':
        return 'x86_amx'
      case 'Token':
        return 'token'
    }
  }
  switch (description._tag) {
    case 'Integer':
      return `i${description.bitWidth}`
    case 'Pointer':
      return description.addressSpace.value === 0
        ? 'ptr'
        : `ptr addrspace(${description.addressSpace.value})`
    case 'Function': {
      const parameters = description.parameters.map((parameter) => renderType(state, parameter))
      if (description.variadic) parameters.push('...')
      return `${renderType(state, description.returnType)} (${parameters.join(', ')})`
    }
    case 'Vector':
      return description.scalable
        ? `<vscale x ${description.length} x ${renderType(state, description.child)}>`
        : `<${description.length} x ${renderType(state, description.child)}>`
    case 'Array':
      return `[${description.length} x ${renderType(state, description.child)}]`
    case 'Structure': {
      const body = description.fields.map((field) => renderType(state, field)).join(', ')
      return description.packed ? `<{ ${body} }>` : `{ ${body} }`
    }
    case 'NamedStructure':
      return identifier('%', description.name)
    case 'TargetExtension': {
      const parameters = [
        quoted(description.name),
        ...description.types.map((type) => renderType(state, type)),
        ...description.integers.map((integer) => integer.toString()),
      ]
      return `target(${parameters.join(', ')})`
    }
  }
}
