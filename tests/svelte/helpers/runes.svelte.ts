/**
 * A reactive cell usable from plain `.ts` test files. Pairing it with getter /
 * setter props lets a test bind to a `$bindable()` prop and read the value back
 * after the component writes to it.
 */
export function box<T>(initial: T): { value: T } {
  let value = $state(initial);
  return {
    get value() {
      return value;
    },
    set value(next: T) {
      value = next;
    },
  };
}
