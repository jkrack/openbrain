import React, { useEffect, useCallback } from "react";

interface ImageLightboxProps {
  images: string[];
  currentIndex: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function ImageLightbox({ images, currentIndex, onClose, onPrev, onNext }: ImageLightboxProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowLeft" && currentIndex > 0) onPrev();
    if (e.key === "ArrowRight" && currentIndex < images.length - 1) onNext();
  }, [currentIndex, images.length, onClose, onPrev, onNext]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="ca-lightbox-overlay" onClick={onClose}>
      <div className="ca-lightbox-content" onClick={(e) => e.stopPropagation()}>
        <img src={images[currentIndex]} alt="" className="ca-lightbox-image" />
        {images.length > 1 && (
          <div className="ca-lightbox-nav">
            <button className="ca-lightbox-arrow" onClick={onPrev} disabled={currentIndex === 0}>&#x2190;</button>
            <span className="ca-lightbox-counter">{currentIndex + 1}/{images.length}</span>
            <button className="ca-lightbox-arrow" onClick={onNext} disabled={currentIndex === images.length - 1}>&#x2192;</button>
          </div>
        )}
        <button className="ca-lightbox-close" onClick={onClose}>&#x2715;</button>
      </div>
    </div>
  );
}
