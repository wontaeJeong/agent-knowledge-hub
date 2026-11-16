import { useState } from "react";
import { Button } from "../ui/primitives";
export function ReviewRejection({
  disabled,
  batchId,
  onReject,
}: {
  disabled: boolean;
  batchId: string;
  onReject: (reason: string) => unknown;
}) {
  const [reason, setReason] = useState("");
  return (
    <div className="op-review-rejection">
      <label>
        반려·수정 요청 사유
        <textarea
          aria-label={`반려 사유 ${batchId}`}
          value={reason}
          maxLength={2000}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
          placeholder="후속 제안에서 반영할 수정 이유"
        />
      </label>
      <Button
        variant="danger"
        disabled={disabled || !reason.trim()}
        onClick={() => onReject(reason.trim())}
      >
        반려
      </Button>
    </div>
  );
}
