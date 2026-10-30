import logging
import numpy as np

logger = logging.getLogger("paddle_engine")

try:
    from paddleocr import PaddleOCR
    HAS_PADDLE = True
except Exception as e:
    PaddleOCR = None
    HAS_PADDLE = False
    logger.warning("PaddleOCR could not be imported; fallback mode enabled: %s", e)


class PaddleOCREngine:
    _instance = None

    def __new__(cls):
        # Singleton pattern to avoid re-initializing models across requests
        if cls._instance is None:
            cls._instance = super(PaddleOCREngine, cls).__new__(cls)
            cls._instance._init_engine()
        return cls._instance

    def _init_engine(self):
        if HAS_PADDLE and PaddleOCR is not None:
            try:
                self.ocr = PaddleOCR(
                    lang="en",
                    use_doc_orientation_classify=False,
                    use_doc_unwarping=False,
                    use_textline_orientation=False,
                )
            except Exception as e:
                logger.error("Failed to initialize PaddleOCR instance: %s", e)
                self.ocr = None
        else:
            self.ocr = None

    def recognize(self, image):
        if not self.ocr:
            return {
                "text": "OCR Engine offline or initializing in cloud runtime.",
                "lines": [],
                "average_confidence": 0.0,
                "engine": "PaddleOCR-Unavailable"
            }
        result = self.ocr.predict(image)

        lines = []
        for page in result:
            data = page.json if hasattr(page, "json") else page
            if callable(data):
                data = data()
            if isinstance(data, dict):
                data = data.get("res", data)
            if not isinstance(data, dict):
                continue

            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            boxes = data.get("rec_polys", data.get("rec_boxes", []))

            for i, text in enumerate(texts):
                confidence = float(scores[i]) if i < len(scores) else None
                box = boxes[i] if i < len(boxes) else None
                if hasattr(box, "tolist"):
                    box = box.tolist()

                lines.append({
                    "text": str(text),
                    "confidence": confidence,
                    "box": box
                })

        full_text = "\n".join(
            line["text"]
            for line in lines
            if line["text"].strip()
        )

        confidences = [
            line["confidence"]
            for line in lines
            if line["confidence"] is not None
        ]

        average_confidence = round(float(np.mean(confidences)), 4) if confidences else None

        return {
            "text": full_text,
            "lines": lines,
            "average_confidence": average_confidence,
            "engine": "PaddleOCR"
        }
