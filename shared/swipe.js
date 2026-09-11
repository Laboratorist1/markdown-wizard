/*
 * Swipe a row aside.
 *
 * One gesture, two lists: the document library and the record list both let a
 * row be dragged out of the way, so the behaviour lives here once. Horizontal
 * only - a move that is more vertical than horizontal is the page being
 * scrolled, which is why a swipeable card yields pan-y to the browser and this
 * never takes the pointer until a sideways drag is unmistakable.
 */
(function (global) {
  'use strict';

  /** row   stays put, and shows the label that sits behind the card
      card  the part that moves under the finger
      done  called with 'left' or 'right' once the card has slid off the edge

      The caller is told nothing until the gesture completes, so a drag that
      springs back changes nothing at all. */
  function enable(row, card, done) {
    var startX = 0;
    var startY = 0;
    var tracking = false;
    var dragging = false;
    var offset = 0;

    function threshold() {
      return Math.max(80, row.offsetWidth * 0.35);
    }

    function settle() {
      card.style.transition = 'transform 160ms ease-out';
      card.style.transform = '';
      row.classList.remove('is-swiping', 'is-armed');
      global.setTimeout(function () { card.style.transition = ''; }, 180);
    }

    function stop() {
      tracking = false;
      startX = 0;
      startY = 0;
    }

    card.addEventListener('pointerdown', function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      tracking = true;
      dragging = false;
      offset = 0;
    });

    card.addEventListener('pointermove', function (event) {
      if (!tracking) return;
      var dx = event.clientX - startX;
      var dy = event.clientY - startY;

      if (!dragging) {
        if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
        dragging = true;
        row.classList.add('is-swiping');
        if (card.setPointerCapture) card.setPointerCapture(event.pointerId);
      }

      offset = dx;
      card.style.transform = 'translateX(' + dx + 'px)';
      row.classList.toggle('is-armed', Math.abs(dx) >= threshold());
    });

    card.addEventListener('pointerup', function () {
      stop();
      if (!dragging) return;
      dragging = false;

      // Any drag at all means the release is not a tap on the row, whether or
      // not it went far enough to take the row out of the list.
      card.dataset.swiped = 'yes';

      if (Math.abs(offset) < threshold()) {
        settle();
        return;
      }

      var direction = offset > 0 ? 'right' : 'left';
      card.style.transition = 'transform 140ms ease-in, opacity 140ms ease-in';
      card.style.transform = 'translateX(' + (offset > 0 ? row.offsetWidth : -row.offsetWidth) + 'px)';
      card.style.opacity = '0';
      global.setTimeout(function () { done(direction); }, 140);
    });

    card.addEventListener('pointercancel', function () {
      stop();
      if (dragging) { dragging = false; settle(); }
    });
  }

  /** True when this click is the tail of a swipe rather than a tap. Clears the
      mark, so asking twice about the same click is not a thing. */
  function wasSwipe(card) {
    if (card.dataset.swiped !== 'yes') return false;
    delete card.dataset.swiped;
    return true;
  }

  global.Swipe = { enable: enable, wasSwipe: wasSwipe };
})(window);
