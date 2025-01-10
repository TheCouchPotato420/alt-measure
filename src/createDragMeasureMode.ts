import OBR, {
  InteractionManager,
  Item,
  Vector2,
  isImage,
  isCurve,
  isShape,
  isLabel,
  ToolEvent,
} from "@owlbear-rodeo/sdk";
import { toolIcon } from "./icons";
import {
  snapPosition,
  calculateSegmentEndPosition,
  calculateDisplayDistance,
  getLabelPosition,
} from "./mathHelpers";
import { DRAG_MEASURE_MODE_ID, getItemId, TOOL_ID } from "./idStrings";
import { Grid, Player, RulerIds } from "./types";
import { buildRuler } from "./rulerBuilder";

export function createDragMeasureMode(grid: Grid, player: Player) {
  let itemInteraction: InteractionManager<Item[]> | null = null;
  let dragStarted = false;
  let currentRulerInitTime = 0;
  let interactionIsExpired = false;

  // Set flags to reset interactions
  const expireAllInteractions = () => {
    // Only expire interactions if the user has started a new drag
    if (dragStarted) {
      interactionIsExpired = true;
    }
  };

  // Act on flags to reset interactions
  const stopExpiredInteractions = () => {
    if (itemInteraction && interactionIsExpired) {
      itemInteraction[1]();
      itemInteraction = null;
      // initialInteractedItem = null;
      dragStarted = false;
      interactionIsExpired = false;
    }
  };

  // State that doesn't require extra handling
  let initialInteractedItem: Item | null = null;
  let sharedAttachments: Item[] = [];
  let localAttachments: Item[] = [];
  let rulerPoints: Vector2[] = []; // Points in the line being measured
  let pointerPosition: Vector2; // Track pointer position so it accessible to keyboard events
  let lastPosition: Vector2; // Memoize last position the token snapped to to prevent path measurement recalculation

  const rulerIds: RulerIds = {
    background: getItemId("background", player.id),
    line: getItemId("line", player.id),
    label: getItemId("label", player.id),
    endDot: getItemId("end-point", player.id),
  };

  const createRulerInteractions = async (event: ToolEvent) => {
    const rulerInitTime = Date.now();
    currentRulerInitTime = rulerInitTime;
    pointerPosition = event.pointerPosition;
    dragStarted = true;
    OBR.scene.items.deleteItems(Object.values(rulerIds));

    const token = event.target;
    if (token && isImage(token) && !token.locked) {
      initialInteractedItem = token;
      const startPosition = await snapPosition(grid, token.position);
      lastPosition = startPosition;
      rulerPoints = [];
      rulerPoints.push(startPosition);

      [itemInteraction, sharedAttachments, localAttachments] =
        await Promise.all([
          OBR.interaction.startItemInteraction([
            ...(await buildRuler(
              rulerIds,
              grid,
              player,
              [startPosition, await snapPosition(grid, pointerPosition)],
              token.visible,
              true
            )),
            token,
          ]),
          OBR.scene.items.getItemAttachments([token.id]),
          OBR.scene.local.getItemAttachments([token.id]),
        ]);
    } else {
      initialInteractedItem = null;
      const startPosition = await snapPosition(grid, pointerPosition);
      lastPosition = startPosition;
      rulerPoints = [];
      rulerPoints.push(startPosition);

      [itemInteraction] = await Promise.all([
        OBR.interaction.startItemInteraction(
          await buildRuler(
            rulerIds,
            grid,
            player,
            [startPosition, pointerPosition],
            true,
            true
          )
        ),
      ]);
    }

    // Because this function is asynchronous and contains await statements, interactions
    // may already be expired if the drag was short enough in duration
    stopExpiredInteractions();

    setTimeout(() => {
      recreateRulerInteractions(rulerInitTime);
    }, 700);
  };

  const recreateRulerInteractions = async (parentRulerInitTime: number) => {
    if (dragStarted && currentRulerInitTime === parentRulerInitTime) {
      let newItemInteraction: InteractionManager<Item[]> | null = null;
      rulerIds.label = getItemId("label", player.id) + Math.random();

      const endPointPosition = await calculateSegmentEndPosition(
        grid,
        rulerPoints[rulerPoints.length - 1],
        pointerPosition
      );
      if (initialInteractedItem !== null) {
        const endPointItem = { ...initialInteractedItem };
        endPointItem.position = endPointPosition;
        [newItemInteraction, sharedAttachments, localAttachments] =
          await Promise.all([
            OBR.interaction.startItemInteraction([
              ...(await buildRuler(
                rulerIds,
                grid,
                player,
                [...rulerPoints, endPointPosition],
                endPointItem.visible,
                true
              )),
              endPointItem,
            ]),
            OBR.scene.items.getItemAttachments([endPointItem.id]),
            OBR.scene.local.getItemAttachments([endPointItem.id]),
          ]);
      } else {
        [newItemInteraction] = await Promise.all([
          OBR.interaction.startItemInteraction(
            await buildRuler(
              rulerIds,
              grid,
              player,
              [...rulerPoints, endPointPosition],
              true,
              true
            )
          ),
        ]);
      }

      expireAllInteractions();
      stopExpiredInteractions();

      dragStarted = true;
      itemInteraction = newItemInteraction;

      // Call again after delay
      setTimeout(() => {
        recreateRulerInteractions(parentRulerInitTime);
      }, 700);
    }
    stopExpiredInteractions();
  };

  OBR.tool.createMode({
    id: DRAG_MEASURE_MODE_ID,
    icons: [
      {
        icon: toolIcon,
        label: "Ruler",
        filter: {
          activeTools: [TOOL_ID],
        },
      },
    ],
    cursors: [
      {
        cursor: "grab",
        filter: {
          target: [
            { key: "locked", value: true, operator: "!=" },
            { key: "image", value: undefined, operator: "!=" },
          ],
        },
      },
      { cursor: "crosshair" },
    ],
    onToolDragStart: async (_, event) => {
      createRulerInteractions(event);
    },
    onToolDragMove: (_, event) => {
      pointerPosition = event.pointerPosition;
      updateToolItems();
      // OBR.player.deselect();
    },
    onKeyDown: async (_, event) => {
      if (itemInteraction || true) {
        if (event.key === "z" || event.key === "Z") {
          // Add segment
          rulerPoints.push(
            await calculateSegmentEndPosition(
              grid,
              rulerPoints[rulerPoints.length - 1],
              pointerPosition
            )
          );
        }

        if (
          (event.key === "x" || event.key === "X") &&
          rulerPoints.length > 1
        ) {
          // Remove most recent segment
          rulerPoints.pop();
          // Refresh with segment removed
          updateToolItems(true);
        }

        if (event.key === "Enter") {
          // Run final update
          const items = await updateToolItems();
          await updateInteractionTargetItems(pointerPosition);

          // Add ruler to the scene
          const ruler: Item[] = [];
          for (let rulerId of Object.values(rulerIds)) {
            for (let item of items) {
              if (item.id === rulerId) {
                ruler.push(item);
                break;
              }
            }
          }
          OBR.scene.items.addItems(ruler);

          expireAllInteractions();
          stopExpiredInteractions();
        }
      }
    },
    onToolDragEnd: async (_, event) => {
      // Run final update
      const items = await updateToolItems();
      await updateInteractionTargetItems(event.pointerPosition);

      // Add ruler to the scene
      const ruler: Item[] = [];
      let addItemsToScene = true;
      for (let rulerId of Object.values(rulerIds)) {
        for (let item of items) {
          if (
            item.id === rulerIds.label &&
            isLabel(item) &&
            item.text.plainText.startsWith("0")
          ) {
            addItemsToScene = false;
          }
          if (item.id === rulerId) {
            ruler.push(item);
            break;
          }
        }
      }
      if (addItemsToScene) OBR.scene.items.addItems(ruler);

      expireAllInteractions();
      stopExpiredInteractions();
    },
    onToolDragCancel: () => {
      // Fix bug where token is not locally displayed at its initial position on cancel
      if (itemInteraction) {
        itemInteraction[0](items => {
          items.forEach(item => {
            if (initialInteractedItem && item.id === initialInteractedItem.id)
              item.position = initialInteractedItem.position;
          });
        });
      }

      expireAllInteractions();
      stopExpiredInteractions();
    },
  });

  async function updateInteractionTargetItems(pointerPosition: Vector2) {
    if (itemInteraction && initialInteractedItem) {
      const newPosition = await calculateSegmentEndPosition(
        grid,
        rulerPoints[rulerPoints.length - 1],
        pointerPosition
      );

      const positionChange = {
        x: newPosition.x - initialInteractedItem.position.x,
        y: newPosition.y - initialInteractedItem.position.y,
      };

      // Update dragged item and shared attachments
      for (let i = 0; i < sharedAttachments.length; i++) {
        sharedAttachments[i].position.x += positionChange.x;
        sharedAttachments[i].position.y += positionChange.y;
      }
      OBR.scene.items.addItems(sharedAttachments);

      // Update local attachments
      for (let i = 0; i < localAttachments.length; i++) {
        localAttachments[i].position.x += positionChange.x;
        localAttachments[i].position.y += positionChange.y;
      }
      OBR.scene.local.addItems(localAttachments);
    }
  }

  async function updateToolItems(forceRecalculation = false): Promise<Item[]> {
    const newPosition = await calculateSegmentEndPosition(
      grid,
      rulerPoints[rulerPoints.length - 1],
      pointerPosition
    );

    let newText: string | null = null;
    if (
      !(lastPosition.x === newPosition.x && newPosition.y === lastPosition.y) ||
      forceRecalculation
    ) {
      newText = await calculateDisplayDistance(grid, [
        ...rulerPoints,
        newPosition,
      ]);
    }
    lastPosition = newPosition;

    let items: Item[] = [];
    if (itemInteraction) {
      items = itemInteraction[0](items => {
        items.forEach(item => {
          if (initialInteractedItem && item.id === initialInteractedItem.id) {
            item.position = newPosition;
          } else if (item.id === rulerIds.line && isCurve(item)) {
            item.points = [...rulerPoints, newPosition];
          } else if (item.id === rulerIds.background && isCurve(item)) {
            item.points = [...rulerPoints, newPosition];
          } else if (item.id === rulerIds.endDot && isShape(item)) {
            item.position = newPosition;
          } else if (item.id.includes(rulerIds.label) && isLabel(item)) {
            item.position = getLabelPosition(grid, newPosition);
            if (newText) item.text.plainText = newText;
          }
        });
      });
    }

    return items;
  }
}
