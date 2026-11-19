type OptionalKeys<T> = { [K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? K : never }[keyof T];

export type Patch<T> = { [K in keyof T]?: K extends OptionalKeys<T> ? T[K] | undefined : T[K] };

export const patch = <T extends object>(target: T, fields: Patch<T>): T => Object.assign(target, fields);
