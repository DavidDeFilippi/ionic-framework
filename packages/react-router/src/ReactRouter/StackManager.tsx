import type { AnimationBuilder, RouteInfo, RouterDirection, StackContextState } from '@ionic/react';
import { RouteManagerContext, StackContext, generateId, getConfig } from '@ionic/react';
import type { ReactNode } from 'react';
import React from 'react';
import { matchPath } from 'react-router-dom';

interface StackManagerProps {
  routeInfo: RouteInfo;
}

interface StackManagerState {
  components: ReactNode[];
}

const isViewVisible = (enteringEl: HTMLElement) => {
  return !enteringEl.classList.contains('ion-page-invisible') && !enteringEl.classList.contains('ion-page-hidden');
};

export class StackManager extends React.PureComponent<StackManagerProps, StackManagerState> {
  id: string;
  context!: React.ContextType<typeof RouteManagerContext>;
  ionRouterOutlet?: React.ReactElement;
  routerOutletElement: HTMLIonRouterOutletElement | undefined;
  prevProps?: StackManagerProps;
  skipTransition: boolean;

  stackContextValue: StackContextState = {
    registerIonPage: this.registerIonPage.bind(this),
    isInOutlet: () => true,
  };

  private clearOutletTimeout: any;

  constructor(props: StackManagerProps) {
    super(props);
    this.registerIonPage = this.registerIonPage.bind(this);
    this.transition = this.transition.bind(this);
    this.handlePageTransition = this.handlePageTransition.bind(this);
    this.id = generateId('ion-router-outlet');
    this.prevProps = undefined;
    this.skipTransition = false;
    this.state = {
      components: [],
    };
  }

  componentDidMount() {
    if (this.clearOutletTimeout) {
      /**
       * The clearOutlet integration with React Router is a bit hacky.
       * It uses a timeout to clear the outlet after a transition.
       * In React v18, components are mounted and unmounted in development mode
       * to check for side effects.
       *
       * This clearTimeout prevents the outlet from being cleared when the component is re-mounted,
       * which should only happen in development mode and as a result of a hot reload.
       */
      clearTimeout(this.clearOutletTimeout);
    }
    if (this.routerOutletElement) {
      this.setupRouterOutlet(this.routerOutletElement);
      this.setupViewItem();
    }
  }

  componentDidUpdate(prevProps: StackManagerProps) {
    const { pathname } = this.props.routeInfo;
    const { pathname: prevPathname } = prevProps.routeInfo;

    if (pathname !== prevPathname) {
      this.prevProps = prevProps;
      console.log('pathname changed... setup view item?!');
      this.setupViewItem();
    }

    // if (pathname !== prevPathname) {
    //   this.prevProps = prevProps;
    //   console.log('calling page transition because path is different', {
    //     pathname,
    //     prevPathname,
    //   });
    //   this.handlePageTransition(this.props.routeInfo);
    // } else if (this.pendingPageTransition) {
    //   console.log('calling page transition because pending transition');
    //   this.handlePageTransition(this.props.routeInfo);
    //   this.pendingPageTransition = false;
    // }
  }

  componentWillUnmount() {
    /**
     * Remove stack data for this outlet
     * when outlet is destroyed otherwise
     * we will see cached view data.
     */
    this.clearOutletTimeout = this.context.clearOutlet(this.id);
  }

  setupViewItem() {
    // TODO additional checks

    const { id, props } = this;
    const { routeInfo } = props;

    /**
     * This function is responsible for creating the entering view item
     * and adding it to the view stack.
     */
    const currentRoute = matchRoute(this.ionRouterOutlet?.props.children, routeInfo) as React.ReactElement;

    let enteringViewItem = this.context.findViewItemByRouteInfo(routeInfo, id);

    if (!enteringViewItem) {
      /**
       * If the entering view item does not exist, this is
       * the first time we are rendering this route.
       *
       * We need to create a view item instance and add it to the view stack.
       * Later, we will mount the view item and transition the page.
       */
      enteringViewItem = this.context.createViewItem(id, currentRoute, routeInfo);

      this.context.addViewItem(enteringViewItem);
    }

    if (!enteringViewItem.mount) {
      /**
       * If the entering view item is not mounted,
       * that means it has not been rendered yet.
       * We need to mount it and then finish the transition
       * after the React component has mounted.
       */
      enteringViewItem.mount = true;
      enteringViewItem.registerCallback = () => {
        this.handlePageTransition();
        if (enteringViewItem) {
          enteringViewItem.registerCallback = undefined;
        }
      };
    } else {
      /**
       * If the entering view item has already mounted,
       * that means the page reference should already
       * exist and we can transition immediately.
       */
      this.handlePageTransition();
    }

    this.setState({
      components: this.context.getChildrenToRender(id, this.ionRouterOutlet!, routeInfo),
    });
  }

  async handlePageTransition() {
    const { id, props } = this;
    const { routeInfo } = props;
    const { prevRouteLastPathname, routeDirection, pushedByRoute, routeAnimation } = routeInfo;

    const enteringViewItem = this.context.findViewItemByRouteInfo(routeInfo, id)!;
    let leavingViewItem = this.context.findLeavingViewItemByRouteInfo(routeInfo, id);
    const enteringEl = enteringViewItem?.ionPageElement;

    /**
     * All views that can be transitioned to must have
     * an `<ion-page>` element for transitions and lifecycle
     * methods to work properly.
     */
    if (enteringEl === undefined) {
      console.warn(`[@ionic/react Warning]: The view you are trying to render for path ${routeInfo.pathname} does not have the required <IonPage> component. Transitions and lifecycle methods may not work as expected.

See https://ionicframework.com/docs/react/navigation#ionpage for more information.`);
    }

    if (enteringViewItem === leavingViewItem) return;

    if (!leavingViewItem && prevRouteLastPathname) {
      leavingViewItem = this.context.findViewItemByPathname(prevRouteLastPathname, id);
    }

    /**
     * If the entering view is already
     * visible, then no transition is needed.
     * This is most common when navigating
     * from a tabs page to a non-tabs page
     * and then back to the tabs page.
     * Even when the tabs context navigated away,
     * the inner tabs page was still active.
     * This also avoids an issue where
     * the previous tabs page is incorrectly
     * unmounted since it would automatically
     * unmount the previous view.
     *
     * This should also only apply to entering and
     * leaving items in the same router outlet (i.e.
     * Tab1 and Tab2), otherwise this will
     * return early for swipe to go back when
     * going from a non-tabs page to a tabs page.
     */
    if (
      enteringEl !== undefined &&
      isViewVisible(enteringEl) &&
      leavingViewItem?.ionPageElement !== undefined &&
      !isViewVisible(leavingViewItem.ionPageElement)
    ) {
      return;
    }

    if (leavingViewItem?.ionPageElement && enteringViewItem !== leavingViewItem) {
      /**
       * The view should only be transitioned in the following cases:
       * 1. Performing a replace or pop action, such as a swipe to go back gesture
       * to animation the leaving view off the screen.
       *
       * 2. Navigating between top-level router outlets, such as /page-1 to /page-2;
       * or navigating within a nested outlet, such as /tabs/tab-1 to /tabs/tab-2.
       *
       * 3. The entering view is an ion-router-outlet containing a page
       * matching the current route and that hasn't already transitioned in.
       *
       * This should only happen when navigating directly to a nested router outlet
       * route or on an initial page load (i.e. refreshing). In cases when loading
       * /tabs/tab-1, we need to transition the /tabs page element into the view.
       */
      this.transition(
        enteringViewItem.ionPageElement!,
        leavingViewItem.ionPageElement!,
        routeDirection!,
        !!pushedByRoute,
        false,
        routeAnimation
      );
    } else {
      /**
       * If there is no leaving element, just show
       * the entering element. Wrap it in an raf
       * in case IonContent's fullscreen callback
       * is running. Otherwise we'd have a flicker.
       */
      requestAnimationFrame(() => enteringEl?.classList.remove('ion-page-invisible'));
    }

    // this.forceUpdate();
  }

  // async handlePageTransition(routeInfo: RouteInfo) {
  //   if (!this.routerOutletElement || !this.routerOutletElement.commit) {
  //     /**
  //      * The route outlet has not mounted yet. We need to wait for it to render
  //      * before we can transition the page.
  //      *
  //      * Set a flag to indicate that we should transition the page after
  //      * the component has updated.
  //      */
  //     this.pendingPageTransition = true;
  //   } else {
  //     console.log('handling page transition...');

  //     let enteringViewItem = this.context.findViewItemByPathname(routeInfo.pathname, this.id);
  //     let leavingViewItem = this.context.findLeavingViewItemByRouteInfo(routeInfo, this.id);

  //     if (!leavingViewItem && routeInfo.prevRouteLastPathname) {
  //       leavingViewItem = this.context.findViewItemByPathname(routeInfo.prevRouteLastPathname, this.id);
  //     }

  //     // Check if leavingViewItem should be unmounted
  //     if (leavingViewItem) {
  //       if (routeInfo.routeAction === 'replace') {
  //         leavingViewItem.mount = false;
  //       } else if (!(routeInfo.routeAction === 'push' && routeInfo.routeDirection === 'forward')) {
  //         if (routeInfo.routeDirection !== 'none' && enteringViewItem !== leavingViewItem) {
  //           leavingViewItem.mount = false;
  //         }
  //       } else if (routeInfo.routeOptions?.unmount) {
  //         leavingViewItem.mount = false;
  //       }
  //     }

  //     const enteringRoute = matchRoute(this.ionRouterOutlet?.props.children, routeInfo) as React.ReactElement;

  //     if (enteringViewItem) {
  //       enteringViewItem.reactElement = enteringRoute;
  //     } else if (enteringRoute) {
  //       enteringViewItem = this.context.createViewItem(this.id, enteringRoute, routeInfo);
  //       this.context.addViewItem(enteringViewItem);
  //     }

  //     if (enteringViewItem && enteringViewItem.ionPageElement) {
  //       /**
  //        * If the entering view item is the same as the leaving view item,
  //        * then we don't need to transition.
  //        */
  //       if (enteringViewItem === leavingViewItem) {
  //         /**
  //          * If the entering view item is the same as the leaving view item,
  //          * we are either transitioning using parameterized routes to the same view
  //          * or a parent router outlet is re-rendering as a result of React props changing.
  //          *
  //          * If the route data does not match the current path, the parent router outlet
  //          * is attempting to transition and we cancel the operation.
  //          */
  //         if (enteringViewItem.routeData.match.url !== routeInfo.pathname) {
  //           return;
  //         }
  //       }

  //       /**
  //        * If there isn't a leaving view item, but the route info indicates
  //        * that the user has routed from a previous path, then we need
  //        * to find the leaving view item to transition between.
  //        */
  //       if (!leavingViewItem && this.props.routeInfo.prevRouteLastPathname) {
  //         leavingViewItem = this.context.findViewItemByPathname(this.props.routeInfo.prevRouteLastPathname, this.id);
  //       }

  //       /**
  //        * If the entering view is already visible and the leaving view is not, the transition does not need to occur.
  //        */
  //       if (
  //         isViewVisible(enteringViewItem.ionPageElement) &&
  //         leavingViewItem !== undefined &&
  //         !isViewVisible(leavingViewItem.ionPageElement!)
  //       ) {
  //         return;
  //       }

  //       /**
  //        * The view should only be transitioned in the following cases:
  //        * 1. Performing a replace or pop action, such as a swipe to go back gesture
  //        * to animation the leaving view off the screen.
  //        *
  //        * 2. Navigating between top-level router outlets, such as /page-1 to /page-2;
  //        * or navigating within a nested outlet, such as /tabs/tab-1 to /tabs/tab-2.
  //        *
  //        * 3. The entering view is an ion-router-outlet containing a page
  //        * matching the current route and that hasn't already transitioned in.
  //        *
  //        * This should only happen when navigating directly to a nested router outlet
  //        * route or on an initial page load (i.e. refreshing). In cases when loading
  //        * /tabs/tab-1, we need to transition the /tabs page element into the view.
  //        */
  //       this.transitionPage(routeInfo, enteringViewItem, leavingViewItem);
  //     } else if (leavingViewItem && !enteringRoute && !enteringViewItem) {
  //       // If we have a leavingView but no entering view/route, we are probably leaving to
  //       // another outlet, so hide this leavingView. We do it in a timeout to give time for a
  //       // transition to finish.
  //       // setTimeout(() => {
  //       if (leavingViewItem.ionPageElement) {
  //         leavingViewItem.ionPageElement.classList.add('ion-page-hidden');
  //         leavingViewItem.ionPageElement.setAttribute('aria-hidden', 'true');
  //       }
  //       // }, 250);
  //     }

  //     this.forceUpdate();
  //   }
  // }

  registerIonPage(routeInfo: RouteInfo, ionPageEl: HTMLElement) {
    const { id } = this;
    const viewItem = this.context.findViewItemByRouteInfo(routeInfo, id)!;
    const oldIonPageEl = viewItem.ionPageElement;

    this.context.registerIonPage(viewItem, ionPageEl);

    /**
     * If there is a registerCallback,
     * then this component is being registered
     * as a result of a navigation change.
     */
    if (viewItem.registerCallback) {
      /**
       * Page should be hidden initially
       * to avoid flickering.
       */
      ionPageEl.classList.add('ion-page-invisible');
      viewItem.registerCallback();
    } else if (oldIonPageEl && !oldIonPageEl.classList.contains('ion-page-invisible')) {
      /**
       * If there is no registerCallback, then
       * this component is likely being re-registered
       * as a result of a hot module replacement.
       * We need to see if the oldIonPageEl has
       * .ion-page-invisible. If it does not then we
       * need to remove it from the new ionPageEl otherwise
       * the page will be hidden when it is replaced.
       */
      ionPageEl.classList.remove('ion-page-invisible');
    }
  }

  async setupRouterOutlet(routerOutlet: HTMLIonRouterOutletElement) {
    const canStart = () => {
      const config = getConfig();
      const swipeEnabled = config && config.get('swipeBackEnabled', routerOutlet.mode === 'ios');
      if (!swipeEnabled) {
        return false;
      }

      const { routeInfo } = this.props;

      const propsToUse =
        this.prevProps && this.prevProps.routeInfo.pathname === routeInfo.pushedByRoute
          ? this.prevProps.routeInfo
          : ({ pathname: routeInfo.pushedByRoute || '' } as any);
      const enteringViewItem = this.context.findViewItemByRouteInfo(propsToUse, this.id, false);

      return (
        !!enteringViewItem &&
        /**
         * The root url '/' is treated as
         * the first view item (but is never mounted),
         * so we do not want to swipe back to the
         * root url.
         */
        enteringViewItem.mount &&
        /**
         * When on the first page (whatever view
         * you land on after the root url) it
         * is possible for findViewItemByRouteInfo to
         * return the exact same view you are currently on.
         * Make sure that we are not swiping back to the same
         * instances of a view.
         */
        enteringViewItem.routeData.match.path !== routeInfo.pathname
      );
    };

    const onStart = async () => {
      const { id } = this;
      const { routeInfo } = this.props;
      let { routeAnimation: animationBuilder } = routeInfo;

      // const propsToUse =
      //   this.prevProps && this.prevProps.routeInfo.pathname === routeInfo.pushedByRoute
      //     ? this.prevProps.routeInfo
      //     : ({ pathname: routeInfo.pushedByRoute || '' } as any);

      const enteringViewItem = this.context.findViewItemByRouteInfo(
        { pathname: routeInfo.pushedByRoute || '' } as RouteInfo,
        id,
        false
      );
      const leavingViewItem = this.context.findViewItemByRouteInfo(routeInfo, id, false);

      if (leavingViewItem) {
        const enteringEl = enteringViewItem?.ionPageElement;
        const leavingEl = leavingViewItem?.ionPageElement;

        /**
         * If we are going back from a page that
         * was presented using a custom animation
         * we should default to using that
         * unless the developer explicitly
         * provided another animation.
         */
        const customAnimation = enteringViewItem!.routerAnimation;
        if (animationBuilder === undefined && customAnimation !== undefined) {
          animationBuilder = customAnimation;
        }

        leavingViewItem.routerAnimation = animationBuilder;

        await this.transition(enteringEl!, leavingEl!, 'back', this.context.canGoBack(), true, animationBuilder);
      }

      // /**
      //  * When the gesture starts, kick off
      //  * a transition that is controlled
      //  * via a swipe gesture.
      //  */
      // if (enteringViewItem && leavingViewItem) {
      //   await this.transition(enteringViewItem.ionPageElement!, leavingViewItem.ionPageElement!, 'back', true, true);
      // }

      return Promise.resolve();
    };
    const onEnd = (shouldContinue: boolean) => {
      if (shouldContinue) {
        this.skipTransition = true;

        this.context.goBack();
      } else {
        /**
         * In the event that the swipe
         * gesture was aborted, we should
         * re-hide the page that was going to enter.
         */
        const { routeInfo } = this.props;

        const propsToUse =
          this.prevProps && this.prevProps.routeInfo.pathname === routeInfo.pushedByRoute
            ? this.prevProps.routeInfo
            : ({ pathname: routeInfo.pushedByRoute || '' } as any);
        const enteringViewItem = this.context.findViewItemByRouteInfo(propsToUse, this.id, false);
        const leavingViewItem = this.context.findViewItemByRouteInfo(routeInfo, this.id, false);

        /**
         * Ionic React has a design defect where it
         * a) Unmounts the leaving view item when using parameterized routes
         * b) Considers the current view to be the entering view when using
         * parameterized routes
         *
         * As a result, we should not hide the view item here
         * as it will cause the current view to be hidden.
         */
        if (enteringViewItem !== leavingViewItem && enteringViewItem?.ionPageElement !== undefined) {
          const { ionPageElement } = enteringViewItem;
          ionPageElement.setAttribute('aria-hidden', 'true');
          ionPageElement.classList.add('ion-page-hidden');
        }
      }
    };

    routerOutlet.swipeHandler = {
      canStart,
      onStart,
      onEnd,
    };
  }

  async transition(
    enteringEl: HTMLElement,
    leavingEl: HTMLElement,
    direction: RouterDirection,
    showGoBack: boolean,
    progressAnimation: boolean,
    animationBuilder?: AnimationBuilder
  ) {
    console.log('transition', {
      enteringEl,
      leavingEl,
      direction,
    });
    const { skipTransition, routerOutletElement } = this;

    /**
     * If the transition was handled
     * via the swipe to go back gesture,
     * then we do not want to perform
     * another transition.
     *
     * We skip adding ion-page or ion-page-invisible
     * because the entering view already exists in the DOM.
     * If we added the classes, there would be a flicker where
     * the view would be briefly hidden.
     */
    if (skipTransition) {
      /**
       * We need to reset skipTransition before
       * we call routerOutlet.commit otherwise
       * the transition triggered by the swipe
       * to go back gesture would reset it. In
       * that case you would see a duplicate
       * transition triggered by handlePageTransition
       * in componentDidUpdate.
       */
      this.skipTransition = false;

      return Promise.resolve(false);
    }

    if (enteringEl === leavingEl) {
      return Promise.resolve(false);
    }

    enteringEl.classList.add('ion-page-invisible');

    const hasRootDirection = direction === undefined || direction === 'root' || direction === 'none';
    const result = await routerOutletElement!.commit(enteringEl, leavingEl, {
      /**
       * replace operations result in a direction of none.
       * These typically do not have need animations, so we set
       * the duration to 0. However, if a developer explicitly
       * passes an animationBuilder, we should assume that
       * they want an animation to be played even
       * though it is a replace operation.
       */
      duration: hasRootDirection && animationBuilder === undefined ? 0 : undefined,
      direction: direction as any, // TODO none isn't a valid direction, investigate
      showGoBack,
      progressAnimation,
      animationBuilder,
    });

    return result;
    // };

    // const routerOutlet = this.routerOutletElement!;

    // const routeInfoFallbackDirection =
    //   routeInfo.routeDirection === 'none' || routeInfo.routeDirection === 'root' ? undefined : routeInfo.routeDirection;
    // const directionToUse = direction ?? routeInfoFallbackDirection;

    // if (enteringViewItem && enteringViewItem.ionPageElement && this.routerOutletElement) {
    //   if (leavingViewItem && leavingViewItem.ionPageElement && enteringViewItem === leavingViewItem) {
    //     // If a page is transitioning to another version of itself
    //     // we clone it so we can have an animation to show

    //     const match = matchComponent(leavingViewItem.reactElement, routeInfo.pathname, true);
    //     if (match) {
    //       const newLeavingElement = clonePageElement(leavingViewItem.ionPageElement.outerHTML);
    //       if (newLeavingElement) {
    //         this.routerOutletElement.appendChild(newLeavingElement);
    //         await runCommit(enteringViewItem.ionPageElement, newLeavingElement);
    //         this.routerOutletElement.removeChild(newLeavingElement);
    //       }
    //     } else {
    //       await runCommit(enteringViewItem.ionPageElement, undefined);
    //     }
    //   } else {
    //     await runCommit(enteringViewItem.ionPageElement, leavingViewItem?.ionPageElement);
    //     if (leavingViewItem && leavingViewItem.ionPageElement && !progressAnimation) {
    //       leavingViewItem.ionPageElement.classList.add('ion-page-hidden');
    //       leavingViewItem.ionPageElement.setAttribute('aria-hidden', 'true');
    //     }
    //   }
    // }
  }

  render() {
    const { children } = this.props;
    const ionRouterOutlet = React.Children.only(children) as React.ReactElement;
    this.ionRouterOutlet = ionRouterOutlet;

    return (
      <StackContext.Provider value={this.stackContextValue}>
        {React.cloneElement(
          ionRouterOutlet as any,
          {
            ref: (node: HTMLIonRouterOutletElement) => {
              if (ionRouterOutlet.props.setRef) {
                ionRouterOutlet.props.setRef(node);
              }
              if (ionRouterOutlet.props.forwardedRef) {
                ionRouterOutlet.props.forwardedRef.current = node;
              }
              if (node) {
                this.routerOutletElement = node;
                console.log('assigned router outlet element node...', node);
              }
              const { ref } = ionRouterOutlet as any;
              if (typeof ref === 'function') {
                ref(node);
              }
            },
          },
          this.state.components
        )}
      </StackContext.Provider>
    );
  }

  static get contextType() {
    return RouteManagerContext;
  }
}

export default StackManager;

function matchRoute(node: React.ReactNode, routeInfo: RouteInfo) {
  let matchedNode: React.ReactNode;
  React.Children.forEach(node as React.ReactElement, (child: React.ReactElement) => {
    const matchProps = {
      exact: child.props.exact,
      path: child.props.path || child.props.from,
      component: child.props.component,
    };
    const match = matchPath(routeInfo.pathname, matchProps);
    if (match) {
      matchedNode = child;
    }
  });

  if (matchedNode) {
    return matchedNode;
  }
  // If we haven't found a node
  // try to find one that doesn't have a path or from prop, that will be our not found route
  React.Children.forEach(node as React.ReactElement, (child: React.ReactElement) => {
    if (!(child.props.path || child.props.from)) {
      matchedNode = child;
    }
  });

  return matchedNode;
}

// function matchComponent(node: React.ReactElement, pathname: string, forceExact?: boolean) {
//   const matchProps = {
//     exact: forceExact ? true : node.props.exact,
//     path: node.props.path || node.props.from,
//     component: node.props.component,
//   };
//   const match = matchPath(pathname, matchProps);

//   return match;
// }
