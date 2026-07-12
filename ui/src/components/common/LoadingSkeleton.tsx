import { Card, CardContent } from "@/components/ui/card";

export function LoadingSkeleton() {
  return (
    <Card>
      <CardContent className="py-8">
        <div className="space-y-4">
          <div className="h-6 w-48 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-full animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-3/4 animate-pulse rounded-md bg-muted" />
          <div className="h-32 w-full animate-pulse rounded-md bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}
