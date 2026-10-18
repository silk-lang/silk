/** Fixed private transfer header shared by drivers and caller-funded execution packages. */
export const headerWords = 18

/** Observer follows child, head, append, execution owner and execution-storage owner. */
export const observerOffset = (wordSize: number): number => wordSize * 5

/** Six by-value diagnostic fields follow the observer; their reference remains borrowed. */
export const causeOffset = (wordSize: number): number => wordSize * 6

/** An owned completed-result reference follows the borrowed cause. */
export const diagnosticResultOffset = (wordSize: number): number => wordSize * 12
