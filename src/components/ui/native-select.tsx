import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "cn"

function NativeSelect({ className, wrapperClassName, ...props }: React.ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <div data-slot="native-select" className={cn("relative inline-flex", wrapperClassName)}>
      <select data-slot="native-select-control" className={cn("w-full", className, "appearance-none pr-8")} {...props} />
      <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export { NativeSelect }
